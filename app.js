(() => {
  "use strict";

  const STORAGE_KEY = "vocabSummerSystemV1";
  const MODES = {
    easy: { label: "轻松模式", newCount: 10, reviewCount: 5, wrongCount: 5 },
    standard: { label: "标准模式", newCount: 15, reviewCount: 5, wrongCount: 5 },
    sprint: { label: "冲刺模式", newCount: 20, reviewCount: 5, wrongCount: 5 },
  };
  const TYPE_LABELS = { new: "新词", review: "复习", wrong: "错词" };
  const CORRECT_MESSAGES = [
    "你好棒，真厉害！",
    "太牛了！",
    "3 连击了！",
    "Bravo！继续加油！",
    "5 连胜，状态真好！",
    "你好 6 呀！",
    "7 连击，完胜！",
    "8 连击，势不可挡！",
    "9 连击，太强了！",
    "10 连击，满分气势！",
  ];
  const WRONG_MESSAGES = ["好可惜，加油！", "没关系，再接再厉！", "差一点，继续努力！", "别灰心，下一题会更好！"];
  const BASE_WORDS = window.VOCAB_DATA.words;
  const BASE_BY_ID = new Map(BASE_WORDS.map((item) => [String(item.id), item]));

  const $ = (id) => document.getElementById(id);
  const views = ["homeView", "testView", "resultView", "wrongView"];
  let state = loadState();
  let nextTimer = null;
  let editingId = null;

  function defaultState() {
    return {
      version: 1,
      mode: "standard",
      speechEnabled: false,
      cursor: 0,
      dayNumber: 1,
      completedDays: [],
      learnedIds: {},
      wrongWords: {},
      corrections: {},
      stats: { totalAnswers: 0, correctAnswers: 0 },
      activeSession: null,
    };
  }

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!parsed || parsed.version !== 1) return defaultState();
      return {
        ...defaultState(),
        ...parsed,
        stats: { ...defaultState().stats, ...(parsed.stats || {}) },
        learnedIds: parsed.learnedIds || {},
        wrongWords: parsed.wrongWords || {},
        corrections: parsed.corrections || {},
        completedDays: parsed.completedDays || [],
      };
    } catch (error) {
      return defaultState();
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function speechSupported() {
    return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  function correctMessage(streak) {
    return CORRECT_MESSAGES[streak - 1] || `${streak} 连击，太厉害了！`;
  }

  function speakEncouragement(message) {
    if (!state.speechEnabled || !speechSupported()) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    utterance.pitch = 1.05;
    window.speechSynthesis.speak(utterance);
  }

  function toggleSpeech() {
    if (!speechSupported()) return;
    state.speechEnabled = !state.speechEnabled;
    if (!state.speechEnabled) window.speechSynthesis.cancel();
    saveState();
    renderHome();
  }

  function showView(id) {
    clearTimeout(nextTimer);
    views.forEach((viewId) => $(viewId).classList.toggle("hidden", viewId !== id));
    window.scrollTo(0, 0);
  }

  function padDay(day) {
    return `Day${String(day).padStart(2, "0")}`;
  }

  function currentItem(id) {
    const base = BASE_BY_ID.get(String(id));
    if (!base) return null;
    const correction = state.corrections[String(id)] || {};
    return { ...base, ...correction };
  }

  function normalizeAnswer(value) {
    return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
  }

  function acceptedAnswers(word) {
    const answers = new Set([word]);
    word.split(/[\/;；]/).forEach((part) => answers.add(part));
    const parenthetical = word.match(/^(.+?)\((.+?)\)$/);
    if (parenthetical) {
      answers.add(parenthetical[1]);
      answers.add(parenthetical[2].replace(/^=/, ""));
    }
    return [...answers].map(normalizeAnswer).filter(Boolean);
  }

  function isCorrectAnswer(input, word) {
    const userAnswers = input.split(/[\/;；]/).map(normalizeAnswer).filter(Boolean);
    const accepted = acceptedAnswers(word);
    return userAnswers.some((answer) => accepted.includes(answer));
  }

  function shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function sortedWrongIds(excluded = new Set()) {
    return Object.entries(state.wrongWords)
      .filter(([id]) => !excluded.has(String(id)))
      .sort((a, b) => {
        const dateCompare = (b[1].last_wrong_date || "").localeCompare(a[1].last_wrong_date || "");
        return dateCompare || (b[1].wrong_count || 0) - (a[1].wrong_count || 0);
      })
      .map(([id]) => String(id));
  }

  function recentReviewPool(excluded) {
    const recent = state.completedDays.slice(-7).flatMap((day) => day.newIds || []);
    const unique = [...new Set(recent.map(String))];
    return unique.filter((id) => !excluded.has(id) && BASE_BY_ID.has(id));
  }

  function buildTodayPlan() {
    const mode = MODES[state.mode];
    const newItems = BASE_WORDS.slice(state.cursor, state.cursor + mode.newCount);
    const newIds = newItems.map((item) => String(item.id));
    const excluded = new Set(newIds);
    const wrongIds = sortedWrongIds(excluded).slice(0, mode.wrongCount);
    wrongIds.forEach((id) => excluded.add(id));
    const reviewIds = shuffle(recentReviewPool(excluded)).slice(0, mode.reviewCount);
    return {
      newIds,
      reviewIds,
      wrongIds,
      questions: [
        ...newIds.map((id) => ({ id, type: "new" })),
        ...reviewIds.map((id) => ({ id, type: "review" })),
        ...wrongIds.map((id) => ({ id, type: "wrong" })),
      ],
    };
  }

  function renderHome() {
    showView("homeView");
    const hasSession = Boolean(state.activeSession);
    const activeToday = hasSession && state.activeSession.kind === "today";
    const activeWrongReview = hasSession && state.activeSession.kind === "wrongReview";
    const plan = activeToday ? state.activeSession.plan : buildTodayPlan();
    $("todayTitle").textContent = padDay(activeToday ? state.activeSession.day : state.dayNumber);
    $("todayStatus").textContent = activeToday
      ? `已完成 ${state.activeSession.index} / ${state.activeSession.questions.length} 题`
      : activeWrongReview ? `错词复习进行中：${state.activeSession.index} / ${state.activeSession.questions.length}`
      : state.cursor >= BASE_WORDS.length ? "新词已全部学完，可继续复习" : MODES[state.mode].label;
    $("newCount").textContent = plan.newIds.length;
    $("reviewCount").textContent = plan.reviewIds.length;
    $("wrongTaskCount").textContent = plan.wrongIds.length;
    $("totalCount").textContent = plan.questions.length;
    $("completedDays").textContent = state.completedDays.length;
    $("learnedWords").textContent = Object.keys(state.learnedIds).length;
    $("wrongCount").textContent = Object.keys(state.wrongWords).length;
    $("accuracy").textContent = state.stats.totalAnswers
      ? `${Math.round((state.stats.correctAnswers / state.stats.totalAnswers) * 100)}%`
      : "—";
    const canSpeak = speechSupported();
    $("speechToggleButton").disabled = !canSpeak;
    $("speechToggleButton").textContent = canSpeak
      ? `语音鼓励：${state.speechEnabled ? "开启" : "关闭"}`
      : "语音鼓励：不支持";
    $("speechToggleButton").setAttribute("aria-pressed", String(Boolean(canSpeak && state.speechEnabled)));
    $("speechSupportText").textContent = canSpeak
      ? "使用浏览器内置语音，不联网。"
      : "当前浏览器不支持语音朗读，将继续使用文字反馈。";
    $("startButton").textContent = activeToday ? "继续今日测试" : "开始今日测试";
    $("startButton").disabled = plan.questions.length === 0 || activeWrongReview;
    $("reviewWrongButton").textContent = activeWrongReview ? "继续错词复习" : "错词复习";
    $("reviewWrongButton").disabled = Object.keys(state.wrongWords).length === 0 && !activeWrongReview;
    document.querySelectorAll('input[name="mode"]').forEach((input) => {
      input.checked = input.value === state.mode;
      input.disabled = hasSession;
    });
  }

  function createTodaySession() {
    const plan = buildTodayPlan();
    if (!plan.questions.length) return;
    state.activeSession = {
      kind: "today",
      day: state.dayNumber,
      mode: state.mode,
      plan,
      questions: plan.questions,
      index: 0,
      correct: 0,
      answered: 0,
      currentAnswered: false,
      encouragementStreak: 0,
      wrongFeedbackIndex: 0,
      startedAt: new Date().toISOString(),
    };
    saveState();
  }

  function createWrongReviewSession() {
    const ids = sortedWrongIds().slice(0, 10);
    if (!ids.length) return;
    state.activeSession = {
      kind: "wrongReview",
      day: state.dayNumber,
      plan: { newIds: [], reviewIds: [], wrongIds: ids, questions: ids.map((id) => ({ id, type: "wrong" })) },
      questions: ids.map((id) => ({ id, type: "wrong" })),
      index: 0,
      correct: 0,
      answered: 0,
      currentAnswered: false,
      encouragementStreak: 0,
      wrongFeedbackIndex: 0,
      startedAt: new Date().toISOString(),
    };
    saveState();
  }

  function renderQuestion() {
    const session = state.activeSession;
    if (!session || session.index >= session.questions.length) {
      finishSession();
      return;
    }
    showView("testView");
    const question = session.questions[session.index];
    const item = currentItem(question.id);
    if (!item) {
      session.index += 1;
      saveState();
      renderQuestion();
      return;
    }
    session.currentAnswered = false;
    $("questionProgress").textContent = `${session.index + 1} / ${session.questions.length}`;
    $("questionType").textContent = TYPE_LABELS[question.type];
    $("questionMeaning").textContent = item.meaning;
    $("questionPos").textContent = `词性：${item.partOfSpeechZh || "其他"}`;
    $("answerInput").value = "";
    $("answerInput").disabled = false;
    $("submitAnswerButton").disabled = false;
    $("dontKnowButton").disabled = false;
    $("feedback").className = "feedback hidden";
    $("feedback").textContent = "";
    $("nextQuestionButton").classList.add("hidden");
    $("answerInput").focus();
  }

  function updateWrongOnWrong(id, item) {
    const key = String(id);
    const old = state.wrongWords[key] || {
      word: item.word,
      meaning: item.meaning,
      wrong_count: 0,
      correct_streak: 0,
      last_wrong_date: "",
    };
    state.wrongWords[key] = {
      ...old,
      word: item.word,
      meaning: item.meaning,
      wrong_count: (old.wrong_count || 0) + 1,
      correct_streak: 0,
      last_wrong_date: new Date().toISOString(),
    };
  }

  function updateWrongOnCorrect(id, item) {
    const key = String(id);
    const old = state.wrongWords[key];
    if (!old) return;
    const streak = (old.correct_streak || 0) + 1;
    if (streak >= 2) {
      delete state.wrongWords[key];
    } else {
      state.wrongWords[key] = { ...old, word: item.word, meaning: item.meaning, correct_streak: streak };
    }
  }

  function submitAnswer(event) {
    event.preventDefault();
    const session = state.activeSession;
    if (!session || session.currentAnswered) return;
    const question = session.questions[session.index];
    const item = currentItem(question.id);
    const input = $("answerInput").value;
    const correct = isCorrectAnswer(input, item.word);
    session.currentAnswered = true;
    session.answered += 1;
    state.stats.totalAnswers += 1;
    $("answerInput").disabled = true;
    $("submitAnswerButton").disabled = true;
    $("dontKnowButton").disabled = true;
    $("feedback").classList.remove("hidden");
    if (correct) {
      session.correct += 1;
      session.encouragementStreak = (session.encouragementStreak || 0) + 1;
      state.stats.correctAnswers += 1;
      updateWrongOnCorrect(question.id, item);
      $("feedback").className = "feedback correct";
      const message = correctMessage(session.encouragementStreak);
      $("feedback").textContent = `√ 正确　${message}`;
      speakEncouragement(message);
      session.index += 1;
      session.currentAnswered = false;
      saveState();
      nextTimer = setTimeout(renderQuestion, 700);
    } else {
      session.encouragementStreak = 0;
      updateWrongOnWrong(question.id, item);
      $("feedback").className = "feedback wrong";
      const messageIndex = session.wrongFeedbackIndex || 0;
      const message = WRONG_MESSAGES[messageIndex % WRONG_MESSAGES.length];
      session.wrongFeedbackIndex = messageIndex + 1;
      $("feedback").textContent = `× 错误　${message}　正确答案：${item.word}`;
      speakEncouragement(message);
      $("nextQuestionButton").classList.remove("hidden");
      saveState();
    }
  }

  function skipQuestion() {
    const session = state.activeSession;
    if (!session || session.currentAnswered) return;
    const question = session.questions[session.index];
    const item = currentItem(question.id);
    session.currentAnswered = true;
    session.answered += 1;
    session.encouragementStreak = 0;
    state.stats.totalAnswers += 1;
    updateWrongOnWrong(question.id, item);
    $("answerInput").disabled = true;
    $("submitAnswerButton").disabled = true;
    $("dontKnowButton").disabled = true;
    $("feedback").className = "feedback wrong";
    const messageIndex = session.wrongFeedbackIndex || 0;
    const message = WRONG_MESSAGES[messageIndex % WRONG_MESSAGES.length];
    session.wrongFeedbackIndex = messageIndex + 1;
    $("feedback").textContent = `已跳过　${message}　正确答案：${item.word}`;
    speakEncouragement(message);
    session.index += 1;
    session.currentAnswered = false;
    saveState();
    nextTimer = setTimeout(renderQuestion, 1300);
  }

  function nextQuestion() {
    const session = state.activeSession;
    if (!session) return;
    session.index += 1;
    session.currentAnswered = false;
    saveState();
    renderQuestion();
  }

  function leaveTest() {
    const session = state.activeSession;
    if (session && session.currentAnswered) {
      session.index += 1;
      session.currentAnswered = false;
      saveState();
    }
    renderHome();
  }

  function finishSession() {
    const session = state.activeSession;
    if (!session) return renderHome();
    const summary = `答对 ${session.correct} 题，共 ${session.answered} 题。`;
    if (session.kind === "today") {
      const newIds = session.plan.newIds.map(String);
      newIds.forEach((id) => { state.learnedIds[id] = true; });
      state.completedDays.push({
        day: session.day,
        date: new Date().toISOString(),
        newIds,
        mode: session.mode,
      });
      state.cursor = Math.min(BASE_WORDS.length, state.cursor + newIds.length);
      state.dayNumber += 1;
    }
    state.activeSession = null;
    saveState();
    $("resultTitle").textContent = session.kind === "today" ? `${padDay(session.day)} 完成` : "错词复习完成";
    $("resultSummary").textContent = summary;
    showView("resultView");
  }

  function openEditDialog() {
    const session = state.activeSession;
    if (!session) return;
    const question = session.questions[session.index];
    const item = currentItem(question.id);
    editingId = String(question.id);
    $("editWordInput").value = item.word;
    $("editMeaningInput").value = item.meaning;
    $("editDialog").showModal();
  }

  function saveCorrection(event) {
    event.preventDefault();
    if (!editingId) return;
    const word = $("editWordInput").value.trim();
    const meaning = $("editMeaningInput").value.trim();
    if (!word || !meaning) return;
    state.corrections[editingId] = { word, meaning };
    if (state.wrongWords[editingId]) {
      state.wrongWords[editingId].word = word;
      state.wrongWords[editingId].meaning = meaning;
    }
    saveState();
    $("editDialog").close();
    editingId = null;
    renderQuestion();
  }

  function renderWrongList() {
    showView("wrongView");
    const entries = sortedWrongIds().map((id) => [id, state.wrongWords[id]]);
    $("wrongListCount").textContent = `${entries.length} 个`;
    $("exportWrongButton").disabled = entries.length === 0;
    $("clearWrongButton").disabled = entries.length === 0;
    const list = $("wrongList");
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "暂无错词。";
      list.append(empty);
      return;
    }
    entries.forEach(([id, entry]) => {
      const item = currentItem(id) || entry;
      const card = document.createElement("article");
      card.className = "wrong-item";
      const title = document.createElement("h3");
      title.textContent = item.word;
      const count = document.createElement("small");
      count.textContent = `错误 ${entry.wrong_count} 次 · 连对 ${entry.correct_streak || 0} 次`;
      const meaning = document.createElement("p");
      meaning.textContent = `${item.partOfSpeechZh || "其他"} · ${item.meaning}`;
      card.append(title, count, meaning);
      list.append(card);
    });
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportWrongCsv() {
    const header = ["word", "meaning", "wrong_count", "correct_streak", "last_wrong_date"];
    const rows = sortedWrongIds().map((id) => {
      const entry = state.wrongWords[id];
      const item = currentItem(id) || entry;
      return [item.word, item.meaning, entry.wrong_count, entry.correct_streak || 0, entry.last_wrong_date];
    });
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `错词库_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function clearWrongWords() {
    if (!confirm("第一次确认：确定要清空全部错词吗？")) return;
    if (!confirm("第二次确认：清空后无法恢复，仍要继续吗？")) return;
    state.wrongWords = {};
    saveState();
    renderWrongList();
  }

  function resetProgress() {
    if (!confirm("第一次确认：重置 Day、学习统计和错词库？家长修正会保留。")) return;
    if (!confirm("第二次确认：学习进度将从 Day01 重新开始，是否继续？")) return;
    const corrections = state.corrections;
    const mode = state.mode;
    const speechEnabled = state.speechEnabled;
    state = defaultState();
    state.corrections = corrections;
    state.mode = mode;
    state.speechEnabled = speechEnabled;
    saveState();
    renderHome();
  }

  document.querySelectorAll('input[name="mode"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (!MODES[input.value] || state.activeSession) return;
      state.mode = input.value;
      saveState();
      renderHome();
    });
  });
  $("startButton").addEventListener("click", () => {
    if (!state.activeSession) createTodaySession();
    renderQuestion();
  });
  $("reviewWrongButton").addEventListener("click", () => {
    if (state.activeSession && state.activeSession.kind !== "wrongReview") {
      alert("请先完成当前今日测试。");
      return;
    }
    if (!state.activeSession) createWrongReviewSession();
    renderQuestion();
  });
  $("answerForm").addEventListener("submit", submitAnswer);
  $("dontKnowButton").addEventListener("click", skipQuestion);
  $("nextQuestionButton").addEventListener("click", nextQuestion);
  $("backHomeButton").addEventListener("click", leaveTest);
  $("resultHomeButton").addEventListener("click", renderHome);
  $("manageWrongButton").addEventListener("click", renderWrongList);
  $("wrongBackButton").addEventListener("click", renderHome);
  $("exportWrongButton").addEventListener("click", exportWrongCsv);
  $("clearWrongButton").addEventListener("click", clearWrongWords);
  $("resetProgressButton").addEventListener("click", resetProgress);
  $("speechToggleButton").addEventListener("click", toggleSpeech);
  $("editWordButton").addEventListener("click", openEditDialog);
  $("editForm").addEventListener("submit", saveCorrection);
  $("cancelEditButton").addEventListener("click", () => $("editDialog").close());

  window.__VOCAB_APP_TEST__ = {
    MODES,
    CORRECT_MESSAGES,
    WRONG_MESSAGES,
    correctMessage,
    speechSupported,
    defaultState,
    normalizeAnswer,
    acceptedAnswers,
    isCorrectAnswer,
    buildTodayPlan,
    sortedWrongIds,
    recentReviewPool,
    currentItem,
    updateWrongOnWrong,
    updateWrongOnCorrect,
    getState: () => state,
    setState: (nextState) => { state = nextState; },
  };

  renderHome();
})();
