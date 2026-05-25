(function () {
  const STORAGE_KEY = "aiTrainerQuizProgressV2";

  // ─── 段位标签 ──────────────────────────────────────────────
  const RANKS = [
    { min: 1,  max: 11, label: "⚔️ 青铜见习",  color: "#cd7f32" },
    { min: 12, max: 22, label: "🥈 白银实战",  color: "#94a3b8" },
    { min: 23, max: 33, label: "🏆 黄金精通",  color: "#fbbf24" },
  ];
  const rankLabel = (lv) => {
    const r = RANKS.find(r => lv >= r.min && lv <= r.max);
    return r ? r.label : "🏆 黄金精通";
  };

  // ─── 核心常量 ──────────────────────────────────────────────
  const xpToNext     = (level) => Math.min(220, 48 + level * 7);
  const WRONG_COOLDOWN_SERIAL = 4;   // 答错后至少隔4题才能再出
  const MASTERY_MIN_CORRECT   = 3;   // 累计答对≥3 → 已掌握
  const MASTERY_FIRST_GAP     = 14;  // 首次掌握后第一次复习间隔
  const MAX_HEARTS            = 5;   // 心愿力上限
  const HISTORY_WINDOW        = 15;  // 强制冷却：同一题15题内不重复出现

  // ─── 鼓励语池 ─────────────────────────────────────────────
  const OK_MSGS = [
    ["答对啦！", "很好！", "对的！", "不错！"],
    ["太棒了！", "势如破竹！", "连击！", "太厉害了！"],
    ["无法阻挡！", "知识爆发！", "超强！", "你在发光！"],
    ["传说级！", "最强训练师！", "封神了！", "你已无敌！"],
  ];
  const WRONG_MSGS = ["再记一次！", "差一点点！", "加油！", "记住它！", "下次一定！"];

  // ─── 解析区情绪鼓励语 ─────────────────────────────────────
  const CORRECT_ENCOURAGE = [
    "💡 来巩固一下这个知识点：",
    "📌 记住它，下次更快：",
    "🧠 理解了就刻进脑子里：",
    "✨ 继续保持！再深化一下：",
    "⚡ 趁热打铁，知识点在这里：",
    "🎯 看看为什么是这个答案：",
    "🔍 加深印象：",
    "🚀 你答对了，再深入一点：",
  ];
  const WRONG_ENCOURAGE = [
    "💪 没关系！来看看关键在哪里：",
    "🤝 错了才有进步，一起分析：",
    "📖 看完这里，你下次肯定会：",
    "🌟 每错一次，记忆就深一次：",
    "💡 这个知识点容易混淆，注意看：",
    "🔥 AI训练师都是这样成长的！加油：",
    "✊ 记住这里，下次遇到就稳了：",
    "😸 猫猫相信你，下次一定行：",
    "🎈 别气馁，看完就会了：",
  ];

  function okMsg(streak) {
    if (streak >= 12) return pickRandom(OK_MSGS[3]);
    if (streak >= 8)  return pickRandom(OK_MSGS[2]);
    if (streak >= 4)  return pickRandom(OK_MSGS[1]);
    return pickRandom(OK_MSGS[0]);
  }

  // ─── 存档结构 ─────────────────────────────────────────────
  const defaultProgress = () => ({
    interview: { level: 1, xp: 0, streak: 0, answered: 0 },
    skills:    { level: 1, xp: 0, streak: 0, answered: 0 },
    weak:      { interview: {}, skills: {} },
    moduleSerial: { interview: 0, skills: 0 },
    qStats:    { interview: {}, skills: {} },
    hearts:    { interview: MAX_HEARTS, skills: MAX_HEARTS },
    recentHistory: { interview: [], skills: [] },
  });

  let progress = loadProgress();
  let currentModule = "interview";
  let currentQuestion = null;
  let sessionAnswered = false;
  let matchState = null;
  let orderState = null;
  let lastPickedSourceId = null;
  let lastRenderedModuleSerial = 0;
  const nextAllowedPickSerial = Object.create(null);

  // ─── 存档读写 ─────────────────────────────────────────────
  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultProgress();
      const p = JSON.parse(raw);
      const d = defaultProgress();
      return {
        ...d, ...p,
        weak:         { interview: p.weak?.interview || {}, skills: p.weak?.skills || {} },
        moduleSerial: { interview: Number(p.moduleSerial?.interview) || 0,
                        skills:    Number(p.moduleSerial?.skills)    || 0 },
        qStats:       { interview: (p.qStats?.interview && typeof p.qStats.interview === "object") ? p.qStats.interview : {},
                        skills:    (p.qStats?.skills    && typeof p.qStats.skills    === "object") ? p.qStats.skills    : {} },
        hearts:       { interview: p.hearts?.interview ?? MAX_HEARTS,
                        skills:    p.hearts?.skills    ?? MAX_HEARTS },
        recentHistory: {
          interview: Array.isArray(p.recentHistory?.interview) ? p.recentHistory.interview.slice(-HISTORY_WINDOW) : [],
          skills:    Array.isArray(p.recentHistory?.skills)    ? p.recentHistory.skills.slice(-HISTORY_WINDOW)    : [],
        },
      };
    } catch { return defaultProgress(); }
  }

  function saveProgress() { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); }

  // ─── 工具函数 ─────────────────────────────────────────────
  const baseIdOf = (q) => (q ? q.sourceId || q.id : "");

  function ensureQStats(id) {
    const m = progress.qStats[currentModule];
    if (!m[id]) m[id] = { tc: 0, tw: 0, nextAt: 0, rev: 0, vr: 0, ef: 2.5 };
    if (m[id].ef == null) m[id].ef = 2.5;
    return m[id];
  }

  const totalCorrect = (id) => Number(ensureQStats(id).tc) || 0;
  const isMastered   = (id) => totalCorrect(id) >= MASTERY_MIN_CORRECT;
  const moduleSerialNow = () => Number(progress.moduleSerial[currentModule]) || 0;

  // ─── SM-2 间隔计算 ────────────────────────────────────────
  // 按遗忘曲线：间隔随每次复习指数增长，ef（记忆难度因子）动态调整
  function reviewGapAfterPhase(phase, ef) {
    const e = (ef != null && ef > 0) ? ef : 2.5;
    const g = Math.floor(MASTERY_FIRST_GAP * Math.pow(e, phase));
    return Math.min(400, Math.max(10, g));
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ─── 答案归一化 ───────────────────────────────────────────
  function normFill(s) {
    return String(s || "").trim().replace(/\s+/g, "").replace(/，/g, ",").toLowerCase();
  }
  const fillOk = (q, input) => q.answers.some(a => normFill(a) === normFill(input));
  const normMultiKey = (arr) => [...arr].sort((a, b) => a - b).join(",");
  const multiAnswerOk = (q, sel) =>
    q.correctIndexes && q.options &&
    normMultiKey(sel) === normMultiKey(q.correctIndexes);
  const multiRightText = (q) =>
    [...q.correctIndexes].sort((a, b) => a - b).map(i => q.options[i]).join("；");

  // ─── 冷却与去重 ───────────────────────────────────────────
  const isCooldownClear   = (q, serial) => {
    const t = nextAllowedPickSerial[baseIdOf(q)];
    return t == null || Number(t) <= serial;
  };
  const passesNotSameAsLast = (q, relaxLast) =>
    relaxLast || !lastPickedSourceId || baseIdOf(q) !== lastPickedSourceId;
  const notInHistory = (q) => {
    const hist = progress.recentHistory?.[currentModule];
    return !hist || !hist.includes(baseIdOf(q));
  };
  const eligible = (q, serial, relaxLast) =>
    isCooldownClear(q, serial) && passesNotSameAsLast(q, relaxLast);

  // ─── 掌握题变式生成 ───────────────────────────────────────
  function choiceToFill(base) {
    const right = base.options[base.answerIndex];
    const uniq = [...new Set([right, right.replace(/[，。、；]/g, ""), right.slice(0, Math.min(24, right.length))].map(s => String(s).trim()).filter(Boolean))];
    return { id: base.id + ":vf", sourceId: base.id, module: base.module, level: base.level,
      type: "fill", question: base.question + "\n（复习·变式：请填写正确选项的关键文字）",
      answers: uniq, explanation: base.explanation, _masteryReview: true };
  }

  function fillToChoice(base, bank) {
    const right = String(base.answers[0] || "").trim();
    const pool = [];
    bank.forEach(o => {
      if (o.type === "choice" && o.options) pool.push(String(o.options[o.answerIndex]).trim());
      else if (o.type === "fill" && o.answers?.length) pool.push(String(o.answers[0]).trim());
    });
    const distr = shuffle(pool.filter(t => t && t !== right)).slice(0, 3);
    while (distr.length < 3) distr.push("以上皆非·占位" + distr.length);
    const opts = shuffle([right, distr[0], distr[1], distr[2]]);
    return { id: base.id + ":vc", sourceId: base.id, module: base.module, level: base.level,
      type: "choice", question: base.question + "\n（复习·变式：选择题）",
      options: opts, answerIndex: opts.indexOf(right), explanation: base.explanation, _masteryReview: true };
  }

  function matchToChoice(base, bank) {
    const right = base.pairs.map(([a, b]) => a + " → " + b).join("；");
    const wrongs = shuffle(bank.filter(o => o.type === "match" && o.id !== base.id && o.pairs)
      .map(o => o.pairs.map(([a, b]) => a + " → " + b).join("；"))).slice(0, 3);
    while (wrongs.length < 3) wrongs.push("（干扰项）" + wrongs.length);
    const opts = shuffle([right, ...wrongs]);
    return { id: base.id + ":vmc", sourceId: base.id, module: base.module, level: base.level,
      type: "choice", question: base.question + "\n（复习·变式：选出配对正确的一项）",
      options: opts, answerIndex: opts.indexOf(right), explanation: base.explanation, _masteryReview: true };
  }

  function matchToFill(base) {
    const [L, R] = base.pairs[0];
    return { id: base.id + ":vmf", sourceId: base.id, module: base.module, level: base.level,
      type: "fill", question: base.question + `\n（复习·变式：「${L}」对应的右侧是？）`,
      answers: [R, R.replace(/[，。]/g, "")], explanation: base.explanation, _masteryReview: true };
  }

  function multiToFillIndices(base) {
    return { id: base.id + ":mf", sourceId: base.id, module: base.module, level: base.level,
      type: "fill", question: base.question + "\n（复习·变式：填正确选项编号，从0开始，逗号分隔）",
      answers: [normMultiKey(base.correctIndexes)], explanation: base.explanation, _masteryReview: true };
  }

  function multiShuffledRound(base) {
    const n = base.options.length;
    const order = shuffle([...Array(n).keys()]);
    const newOpts = order.map(i => base.options[i]);
    const newPosOfOld = new Array(n);
    order.forEach((oldIdx, newIdx) => { newPosOfOld[oldIdx] = newIdx; });
    const newCorrect = [...base.correctIndexes].map(old => newPosOfOld[old]).sort((a, b) => a - b);
    return { ...base, id: base.id + ":vms", sourceId: base.id, options: newOpts, correctIndexes: newCorrect, _masteryReview: true };
  }

  function fillToMiniMatch(base) {
    const ans = String(base.answers[0] || "").trim();
    return { id: base.id + ":vmm", sourceId: base.id, module: base.module, level: base.level,
      type: "match", question: base.question + "\n（复习·变式：连线）",
      pairs: [["本题要点", ans], ["干扰A", "与题干无关·甲"], ["干扰B", "与题干无关·乙"]],
      explanation: base.explanation, _masteryReview: true };
  }

  // 判断题变式
  function truefalseTofill(base) {
    return { id: base.id + ":vtff", sourceId: base.id, module: base.module, level: base.level,
      type: "fill", question: base.question + "\n（复习·变式：这句话是「正确」还是「错误」？请填写）",
      answers: [base.correct ? "正确" : "错误"], explanation: base.explanation, _masteryReview: true };
  }

  function truefalseTochoice(base, bank) {
    const rightLabel = base.correct ? "这句话是正确的" : "这句话是错误的";
    const opts = shuffle([rightLabel, "这句话是错误的", "这句话是正确的", "这句话部分正确"].filter((v, i, a) => a.indexOf(v) === i).slice(0, 4));
    while (opts.length < 4) opts.push("以上均不对");
    return { id: base.id + ":vtfc", sourceId: base.id, module: base.module, level: base.level,
      type: "choice", question: base.question + "\n（复习·变式：判断正误）",
      options: opts, answerIndex: opts.indexOf(rightLabel) < 0 ? 0 : opts.indexOf(rightLabel),
      explanation: base.explanation, _masteryReview: true };
  }

  // 排序题变式
  function orderToFill(base) {
    return { id: base.id + ":vof", sourceId: base.id, module: base.module, level: base.level,
      type: "fill", question: base.question + "\n（复习·变式：第一个步骤的关键词是什么？）",
      answers: [base.steps[0].replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, "").split("（")[0].trim()],
      explanation: base.explanation, _masteryReview: true };
  }

  function orderToChoice(base, bank) {
    const right = base.steps.map(s => s.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, "").split("（")[0].trim().slice(0, 12)).join(" → ");
    const wrongs = [];
    bank.filter(q => q.type === "order" && q.id !== base.id).forEach(q => {
      const s = q.steps.map(s => s.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, "").split("（")[0].trim().slice(0, 12)).join(" → ");
      if (s !== right) wrongs.push(s);
    });
    // Generate shuffled wrong versions of current steps
    const shuffledWrong = shuffle(base.steps).map(s => s.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, "").split("（")[0].trim().slice(0, 12)).join(" → ");
    if (shuffledWrong !== right) wrongs.push(shuffledWrong);
    const distr = shuffle(wrongs).slice(0, 3);
    while (distr.length < 3) distr.push("（干扰选项）" + distr.length);
    const opts = shuffle([right, distr[0], distr[1], distr[2]]);
    return { id: base.id + ":voc", sourceId: base.id, module: base.module, level: base.level,
      type: "choice", question: base.question.replace("排列：", "，下列哪个顺序是正确的？"),
      options: opts, answerIndex: opts.indexOf(right), explanation: base.explanation, _masteryReview: true };
  }

  function buildMasteryVariant(base, bank) {
    const st = ensureQStats(base.id);
    const step = Number(st.vr) % 3;
    st.vr = Number(st.vr) + 1;

    if (base.type === "truefalse") {
      if (step === 0) return { ...base, sourceId: base.id, _masteryReview: true };
      if (step === 1) return truefalseTofill(base);
      return truefalseTochoice(base, bank);
    }
    if (base.type === "order") {
      if (step === 0) return { ...base, sourceId: base.id, _masteryReview: true };
      if (step === 1) return orderToFill(base);
      return orderToChoice(base, bank);
    }
    if (base.type === "choice") {
      if (step === 0) return { ...base, sourceId: base.id, _masteryReview: true };
      if (step === 1) return choiceToFill(base);
      return fillToChoice({ id: base.id, module: base.module, level: base.level,
        question: base.question, explanation: base.explanation, type: "fill",
        answers: [base.options[base.answerIndex]] }, bank);
    }
    if (base.type === "fill") {
      if (step === 0) return { ...base, sourceId: base.id, _masteryReview: true };
      if (step === 1) return fillToChoice(base, bank);
      return fillToMiniMatch(base);
    }
    if (base.type === "match") {
      if (step === 0) return { ...base, sourceId: base.id, _masteryReview: true };
      if (step === 1) return matchToChoice(base, bank);
      return matchToFill(base);
    }
    if (base.type === "multi") {
      if (step === 0) return { ...base, sourceId: base.id, _masteryReview: true };
      if (step === 1) return multiToFillIndices(base);
      return multiShuffledRound(base);
    }
    return { ...base, sourceId: base.id, _masteryReview: true };
  }

  // ─── 抽题算法（全随机 + 遗忘曲线 + 15题历史窗口） ──────────
  function pickQuestion() {
    const bank    = window.AI_TRAINER_QUESTIONS.filter(q => q.module === currentModule);
    const weakMap = progress.weak[currentModule];
    const weakIds = Object.keys(weakMap).filter(id => Number(weakMap[id]) < 2 && !isMastered(id));
    const serial  = moduleSerialNow();

    // 1. 掌握题复习池（遗忘曲线触发）
    const masteryDueIds = bank.map(q => q.id).filter(id => {
      if (!isMastered(id)) return false;
      const s = ensureQStats(id);
      if (!Number(s.nextAt)) { s.nextAt = serial + 2; saveProgress(); }
      return serial >= Number(s.nextAt);
    }).filter(id => {
      const t = nextAllowedPickSerial[id];
      return (t == null || Number(t) <= serial)
        && (lastPickedSourceId ? id !== lastPickedSourceId : true)
        && !(progress.recentHistory?.[currentModule] || []).includes(id);
    });

    const injectMastery = masteryDueIds.length && Math.random() < 0.38;
    if (injectMastery) {
      const mid  = pickRandom(masteryDueIds);
      const base = bank.find(q => q.id === mid);
      if (base) return { q: buildMasteryVariant(base, bank), fromWeak: false, mastery: true };
    }

    // 2. 错题池（高频出现，帮助记忆）
    let weakPool = weakIds.map(id => bank.find(q => q.id === id)).filter(Boolean)
      .filter(q => notInHistory(q) && eligible(q, serial, false));
    if (!weakPool.length && weakIds.length)
      weakPool = weakIds.map(id => bank.find(q => q.id === id)).filter(Boolean)
        .filter(q => notInHistory(q) && eligible(q, serial, true));

    const injectWeak = weakPool.length && Math.random() < 0.35;
    if (injectWeak) return { q: pickRandom(weakPool), fromWeak: true, mastery: false };

    // 3. 全题库随机（不按等级过滤），先用历史窗口约束，逐步放宽
    let pool = bank.filter(q => !isMastered(q.id) && notInHistory(q) && eligible(q, serial, false));
    if (!pool.length) pool = bank.filter(q => !isMastered(q.id) && notInHistory(q) && eligible(q, serial, true));
    if (!pool.length) pool = bank.filter(q => !isMastered(q.id) && notInHistory(q) && isCooldownClear(q, serial));
    // 历史窗口放宽（题库数量不足时）
    if (!pool.length) pool = bank.filter(q => !isMastered(q.id) && eligible(q, serial, false));
    if (!pool.length) pool = bank.filter(q => !isMastered(q.id) && isCooldownClear(q, serial));
    if (!pool.length) pool = bank.filter(q => !isMastered(q.id));
    if (!pool.length) {
      const mid = masteryDueIds[0];
      const base = bank.find(q => q.id === mid);
      if (base) return { q: buildMasteryVariant(base, bank), fromWeak: false, mastery: true };
    }
    if (!pool.length) pool = bank.slice();

    return { q: pickRandom(pool), fromWeak: false, mastery: false };
  }

  // ─── 错题池管理 ───────────────────────────────────────────
  function registerWeak(id, correct) {
    if (isMastered(id)) return;
    const map = progress.weak[currentModule];
    if (correct) {
      if (Object.prototype.hasOwnProperty.call(map, id)) {
        map[id] = Number(map[id] || 0) + 1;
        if (map[id] >= 2) delete map[id];
      }
    } else {
      map[id] = 0;
    }
    saveProgress();
  }

  // ─── 经验值与心愿力 ──────────────────────────────────────
  function award(correct) {
    const st = progress[currentModule];
    st.answered += 1;
    const prevLevel = st.level;
    if (correct) {
      st.streak += 1;
      // 连击倍率：1x → 1.5x → 2x
      const mult = st.streak >= 10 ? 2 : st.streak >= 5 ? 1.5 : 1;
      const base = 12 + Math.min(10, Math.floor(st.streak / 2));
      const gain = Math.round(base * mult);
      st.xp += gain;
      const need = xpToNext(st.level);
      while (st.xp >= need && st.level < 33) {
        st.xp -= need;
        st.level += 1;
      }
      if (st.level === 33 && st.xp > need) st.xp = need;
      // 每5连击恢复1颗心
      if (st.streak % 5 === 0) {
        progress.hearts[currentModule] = Math.min(MAX_HEARTS, progress.hearts[currentModule] + 1);
      }
      showXpFloat(gain, mult > 1);
    } else {
      st.streak = 0;
      // 心愿力减少
      if (progress.hearts[currentModule] > 0) {
        progress.hearts[currentModule] -= 1;
      }
    }
    saveProgress();
    if (correct && st.level > prevLevel) {
      setTimeout(() => showLevelUp(st.level, prevLevel), 400);
    }
    return { xpGain: correct ? (12 + Math.min(10, Math.floor(st.streak / 2))) : 0 };
  }

  // ─── 浮动 XP 动画 ────────────────────────────────────────
  function showXpFloat(amount, bonus) {
    const el = document.getElementById("xp-float");
    if (!el) return;
    el.textContent = (bonus ? "⚡ ×2 " : "") + "+" + amount + " XP";
    el.className = "xp-float show" + (bonus ? " bonus" : "");
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.className = "xp-float"; }, 1200);
  }

  // ─── 升级庆典 ─────────────────────────────────────────────
  function showLevelUp(newLevel, oldLevel) {
    const overlay = document.getElementById("levelup-overlay");
    if (!overlay) return;
    const rankChanged = rankLabel(newLevel) !== rankLabel(oldLevel);
    document.getElementById("lu-level").textContent = newLevel;
    document.getElementById("lu-rank").textContent = rankChanged ? "🎖️ 晋升：" + rankLabel(newLevel) : rankLabel(newLevel);
    document.getElementById("lu-rank").style.color = rankChanged ? "var(--amber)" : "var(--muted)";
    overlay.classList.add("show");
    launchConfetti();
    setTimeout(() => overlay.classList.remove("show"), 2600);
  }

  // ─── 礼花特效 ─────────────────────────────────────────────
  function launchConfetti() {
    const container = document.getElementById("confetti-container");
    if (!container) return;
    container.innerHTML = "";
    const colors = ["#22c55e", "#fbbf24", "#38bdf8", "#a78bfa", "#f87171", "#fb923c"];
    for (let i = 0; i < 38; i++) {
      const el = document.createElement("div");
      el.className = "confetti-piece";
      el.style.cssText = `
        left:${Math.random() * 100}%;
        background:${colors[Math.floor(Math.random() * colors.length)]};
        width:${6 + Math.random() * 6}px;
        height:${8 + Math.random() * 8}px;
        border-radius:${Math.random() > 0.5 ? "50%" : "2px"};
        animation-delay:${Math.random() * 0.5}s;
        animation-duration:${0.9 + Math.random() * 0.8}s;
      `;
      container.appendChild(el);
    }
    setTimeout(() => { container.innerHTML = ""; }, 2000);
  }

  // ─── UI 刷新 ─────────────────────────────────────────────
  function showHome() {
    document.getElementById("view-home").classList.remove("hidden");
    document.getElementById("view-play").classList.add("hidden");
    refreshHomeStats();
  }

  function showPlay() {
    document.getElementById("view-home").classList.add("hidden");
    document.getElementById("view-play").classList.remove("hidden");
    refreshMeta();
    renderQuestion();
  }

  function refreshHomeStats() {
    ["interview", "skills"].forEach(mod => {
      const st = progress[mod];
      const el = document.getElementById(`home-stats-${mod}`);
      if (el) {
        const total = window.AI_TRAINER_QUESTIONS.filter(q => q.module === mod).length;
        const mastered = Object.values(progress.qStats[mod]).filter(s => s.tc >= MASTERY_MIN_CORRECT).length;
        el.textContent = `Lv.${st.level} · ${mastered}/${total} 已掌握`;
      }
    });
  }

  function refreshMeta() {
    const st = progress[currentModule];
    const hearts = progress.hearts[currentModule];
    document.getElementById("play-module-label").textContent =
      currentModule === "interview" ? "🗣️ 面试模块" : "🛠️ 技能模块";
    document.getElementById("play-rank-label").textContent = rankLabel(st.level);
    document.getElementById("play-level").textContent = String(st.level);

    // 连胜
    const streakEl = document.getElementById("play-streak");
    if (streakEl) {
      const fire = st.streak >= 10 ? "🔥🔥" : "🔥";
      streakEl.textContent = fire + " " + st.streak;
      streakEl.className = "pill streak" + (st.streak >= 5 ? " hot" : "");
    }

    // 心愿力
    const heartsEl = document.getElementById("play-hearts");
    if (heartsEl) {
      heartsEl.textContent =
        "❤️".repeat(hearts) + "🖤".repeat(Math.max(0, MAX_HEARTS - hearts));
    }

    const need = xpToNext(st.level);
    const pct = st.level >= 33 ? 100 : Math.round((st.xp / need) * 100);
    const xpBar = document.getElementById("xp-bar");
    if (xpBar) xpBar.style.width = pct + "%";
  }

  function typeLabel(type, q) {
    const labels = { choice: "单选题", fill: "填空题", match: "连线题", multi: "多选题",
                     truefalse: "判断题", order: "排序题" };
    let t = labels[type] || type;
    if (q?._masteryReview) t += " · 间隔复习";
    return t;
  }

  // ─── 渲染题目 ────────────────────────────────────────────
  function renderQuestion() {
    sessionAnswered = false;
    orderState = null;
    progress.moduleSerial = progress.moduleSerial || { interview: 0, skills: 0 };
    progress.moduleSerial[currentModule] = (Number(progress.moduleSerial[currentModule]) || 0) + 1;
    saveProgress();
    lastRenderedModuleSerial = moduleSerialNow();

    const { q } = pickQuestion();
    lastPickedSourceId = baseIdOf(q);
    currentQuestion = q;

    // 记录历史窗口（持久化，防止刷新后重复）
    const hist = progress.recentHistory[currentModule];
    hist.push(baseIdOf(q));
    if (hist.length > HISTORY_WINDOW) hist.splice(0, hist.length - HISTORY_WINDOW);
    saveProgress();

    const qCard = document.getElementById("question-card");
    qCard.classList.remove("boss-level");
    // Boss 关卡（每隔5级有一个强化题）
    if (q.level % 5 === 0 && !q._masteryReview) {
      qCard.classList.add("boss-level");
    }

    document.getElementById("q-type").textContent = typeLabel(q.type, q);
    document.getElementById("q-text").textContent = q.question;

    const body = document.getElementById("q-body");
    const fb   = document.getElementById("feedback");
    body.innerHTML = "";
    fb.classList.add("hidden");

    if (q.type === "choice") renderChoice(q, body);
    else if (q.type === "fill") renderFill(body);
    else if (q.type === "match") matchState = buildMatchUI(q, body);
    else if (q.type === "multi") renderMulti(q, body);
    else if (q.type === "truefalse") renderTrueFalse(q, body);
    else if (q.type === "order") orderState = buildOrderUI(q, body);
  }

  // ─── 题型渲染 ─────────────────────────────────────────────
  function renderChoice(q, body) {
    q.options.forEach((opt, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "choice-btn";
      b.textContent = opt;
      b.addEventListener("click", () => onChoice(idx, b));
      body.appendChild(b);
    });
  }

  function renderFill(body) {
    const row = document.createElement("div");
    row.className = "fill-row";
    row.innerHTML =
      '<input type="text" id="fill-input" autocomplete="off" placeholder="输入答案…" />' +
      '<button type="button" class="btn primary" id="fill-submit">提交</button>';
    body.appendChild(row);
    document.getElementById("fill-submit").addEventListener("click", onFillSubmit);
    document.getElementById("fill-input").addEventListener("keydown", e => {
      if (e.key === "Enter") onFillSubmit();
    });
    setTimeout(() => document.getElementById("fill-input")?.focus(), 30);
  }

  function renderMulti(q, body) {
    const hint = document.createElement("p");
    hint.className = "multi-hint";
    hint.textContent = "可多选：点击选项切换选中，选好后点「提交答案」。";
    body.appendChild(hint);
    q.options.forEach((opt, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "multi-opt";
      b.textContent = String.fromCharCode(65 + idx) + ". " + opt;
      b.dataset.idx = String(idx);
      b.addEventListener("click", () => {
        if (sessionAnswered) return;
        b.classList.toggle("selected");
      });
      body.appendChild(b);
    });
    const sub = document.createElement("button");
    sub.type = "button";
    sub.className = "btn primary";
    sub.id = "multi-submit";
    sub.textContent = "提交答案";
    body.appendChild(sub);
    sub.addEventListener("click", onMultiSubmit);
  }

  // ─── 判断题 UI ────────────────────────────────────────────
  function renderTrueFalse(q, body) {
    const hint = document.createElement("p");
    hint.className = "tf-hint";
    hint.textContent = "判断以上说法是否正确：";
    body.appendChild(hint);

    const wrap = document.createElement("div");
    wrap.className = "tf-wrap";

    const btnT = document.createElement("button");
    btnT.type = "button";
    btnT.className = "tf-btn tf-true";
    btnT.innerHTML = "✓ 正确";
    btnT.addEventListener("click", () => onTrueFalse(true));
    wrap.appendChild(btnT);

    const btnF = document.createElement("button");
    btnF.type = "button";
    btnF.className = "tf-btn tf-false";
    btnF.innerHTML = "✗ 错误";
    btnF.addEventListener("click", () => onTrueFalse(false));
    wrap.appendChild(btnF);

    body.appendChild(wrap);
  }

  function onTrueFalse(userAnswer) {
    if (sessionAnswered) return;
    const q   = currentQuestion;
    const ok  = userAnswer === q.correct;
    const btns = document.querySelectorAll(".tf-btn");
    btns.forEach(b => {
      b.disabled = true;
      if ((b.classList.contains("tf-true") && q.correct) ||
          (b.classList.contains("tf-false") && !q.correct)) {
        b.classList.add("correct");
      } else if ((b.classList.contains("tf-true") && userAnswer && !ok) ||
                 (b.classList.contains("tf-false") && !userAnswer && !ok)) {
        b.classList.add("wrong");
      }
    });
    finalize(ok, q.correct ? "正确" : "错误");
  }

  // ─── 排序题 UI ────────────────────────────────────────────
  function buildOrderUI(q, body) {
    const displaySteps = shuffle(q.steps.map((text, origIdx) => ({ text, origIdx })));
    const state = { displaySteps, selected: [], total: q.steps.length };

    const hint = document.createElement("p");
    hint.className = "order-hint";
    hint.textContent = "按正确顺序依次点击各步骤（点错可重选）：";
    body.appendChild(hint);

    const grid = document.createElement("div");
    grid.className = "order-grid";

    displaySteps.forEach((item, dispIdx) => {
      const el = document.createElement("div");
      el.className = "order-step";
      el.dataset.dispIdx = String(dispIdx);
      el.dataset.origIdx = String(item.origIdx);

      const badge = document.createElement("span");
      badge.className = "order-badge";
      badge.textContent = "";

      const label = document.createElement("span");
      label.className = "order-label";
      label.textContent = item.text;

      el.appendChild(badge);
      el.appendChild(label);
      el.addEventListener("click", () => onOrderClick(state, el, badge, grid, q));
      grid.appendChild(el);
      item.el    = el;
      item.badge = badge;
    });

    body.appendChild(grid);
    return state;
  }

  function onOrderClick(state, el, badge, grid, q) {
    if (sessionAnswered) return;
    const dispIdx = Number(el.dataset.dispIdx);
    const origIdx = Number(el.dataset.origIdx);
    const pos = state.selected.findIndex(s => s.dispIdx === dispIdx);

    if (pos >= 0) {
      // 取消选中：移除，更新后面所有编号
      state.selected.splice(pos, 1);
      orderRefreshBadges(state, q);
      return;
    }

    // 添加到选中列表
    state.selected.push({ dispIdx, origIdx });
    orderRefreshBadges(state, q);

    // 全部选完 → 自动验证
    if (state.selected.length === state.total) {
      setTimeout(() => validateOrder(state, q), 120);
    }
  }

  function orderRefreshBadges(state, q) {
    state.displaySteps.forEach(item => {
      const pos = state.selected.findIndex(s => s.dispIdx === Number(item.el.dataset.dispIdx));
      item.el.classList.toggle("selected", pos >= 0);
      item.badge.textContent = pos >= 0 ? String(pos + 1) : "";
    });
  }

  function validateOrder(state, q) {
    if (sessionAnswered) return;
    // 检查：用户点击顺序的 origIdx 数组是否等于 [0,1,2,3,4...]
    const userOrigOrder = state.selected.map(s => s.origIdx);
    const expectedOrder = q.steps.map((_, i) => i);
    const ok = userOrigOrder.join(",") === expectedOrder.join(",");

    // 标记正确/错误
    state.displaySteps.forEach(item => {
      const pos = state.selected.findIndex(s => s.dispIdx === Number(item.el.dataset.dispIdx));
      if (pos >= 0) {
        const isRight = userOrigOrder[pos] === pos;
        item.el.classList.add(ok ? "correct" : (isRight ? "correct" : "wrong"));
      }
      item.el.style.pointerEvents = "none";
    });

    const rightText = q.steps.map(s => s.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, "").split("（")[0].trim().slice(0, 18)).join(" → ");
    finalize(ok, rightText);
  }

  // ─── 连线题 UI ────────────────────────────────────────────
  function buildMatchUI(q, body) {
    const lefts  = q.pairs.map(p => p[0]);
    const rights = shuffle(q.pairs.map(p => p[1]));
    const map = {};
    q.pairs.forEach(([l, r]) => { map[l] = r; });

    const grid  = document.createElement("div");
    grid.className = "match-grid";
    const colL = document.createElement("div");
    const colR = document.createElement("div");
    colL.className = "match-col";
    colR.className = "match-col";
    colL.innerHTML = "<h4>左侧</h4>";
    colR.innerHTML = "<h4>右侧（已打乱）</h4>";

    const state = { map, matched: new Set(), selectedLeft: null,
                    leftEls: {}, rightEls: {}, wrongAttempts: 0 };

    lefts.forEach(text => {
      const el = document.createElement("div");
      el.className = "match-item";
      el.textContent = text;
      el.dataset.key = text;
      el.addEventListener("click", () => onMatchLeftClick(state, el));
      colL.appendChild(el);
      state.leftEls[text] = el;
    });
    rights.forEach(text => {
      const el = document.createElement("div");
      el.className = "match-item";
      el.textContent = text;
      el.dataset.key = text;
      el.addEventListener("click", () => onMatchRightClick(state, el));
      colR.appendChild(el);
      state.rightEls[text] = el;
    });
    grid.appendChild(colL);
    grid.appendChild(colR);
    body.appendChild(grid);
    return state;
  }

  function clearMatchSelect(state) {
    state.selectedLeft = null;
    Object.values(state.leftEls).forEach(el => el.classList.remove("selected"));
  }

  function onMatchLeftClick(state, el) {
    if (sessionAnswered || el.classList.contains("matched")) return;
    if (state.selectedLeft === el) { clearMatchSelect(state); return; }
    clearMatchSelect(state);
    state.selectedLeft = el;
    el.classList.add("selected");
  }

  function onMatchRightClick(state, el) {
    if (sessionAnswered || el.classList.contains("matched") || !state.selectedLeft) return;
    const leftKey  = state.selectedLeft.dataset.key;
    const rightKey = el.dataset.key;
    if (state.map[leftKey] === rightKey) {
      state.selectedLeft.classList.add("matched");
      el.classList.add("matched");
      clearMatchSelect(state);
      state.matched.add(leftKey);
      if (state.matched.size === Object.keys(state.map).length) {
        finalize(state.wrongAttempts === 0, currentQuestion.pairs.map(([a, b]) => a + " → " + b).join("；"));
      }
    } else {
      state.wrongAttempts += 1;
      el.classList.add("bad");
      setTimeout(() => el.classList.remove("bad"), 400);
    }
  }

  // ─── 选择题回调 ──────────────────────────────────────────
  function onChoice(idx, btnEl) {
    if (sessionAnswered) return;
    const q  = currentQuestion;
    const ok = idx === q.answerIndex;
    document.querySelectorAll("#q-body .choice-btn").forEach((b, i) => {
      b.disabled = true;
      if (i === q.answerIndex) b.classList.add("correct");
      else if (i === idx && !ok) b.classList.add("wrong");
    });
    finalize(ok, q.options[q.answerIndex]);
  }

  function onFillSubmit() {
    if (sessionAnswered) return;
    const ok = fillOk(currentQuestion, document.getElementById("fill-input")?.value || "");
    finalize(ok, currentQuestion.answers.join(" 或 "));
  }

  function onMultiSubmit() {
    if (sessionAnswered) return;
    const q = currentQuestion;
    const selected = Array.from(document.querySelectorAll("#q-body .multi-opt.selected"))
      .map(el => Number(el.dataset.idx));
    const ok = multiAnswerOk(q, selected);
    document.querySelectorAll("#q-body .multi-opt").forEach(btn => {
      const idx = Number(btn.dataset.idx);
      btn.disabled = true;
      if (q.correctIndexes.includes(idx)) btn.classList.add("correct");
      else if (selected.includes(idx)) btn.classList.add("wrong");
    });
    const sub = document.getElementById("multi-submit");
    if (sub) sub.disabled = true;
    finalize(ok, multiRightText(q));
  }

  // ─── 结算（核心） ────────────────────────────────────────
  function finalize(ok, rightText) {
    sessionAnswered = true;
    const bid  = baseIdOf(currentQuestion);
    const ms   = moduleSerialNow();
    const st   = ensureQStats(bid);
    const beforeTc = Number(st.tc) || 0;

    // 冷却与 SM-2 更新
    if (!ok) {
      nextAllowedPickSerial[bid] = lastRenderedModuleSerial + WRONG_COOLDOWN_SERIAL;
      // SM-2：降低 ef，加大下次复习频率
      st.ef = Math.max(1.3, (st.ef || 2.5) - 0.2);
      st.tw = (Number(st.tw) || 0) + 1;
      if (beforeTc >= MASTERY_MIN_CORRECT) {
        st.nextAt = ms + WRONG_COOLDOWN_SERIAL;
      }
    } else {
      st.tc = beforeTc + 1;
      // SM-2：提高 ef，拉长复习间隔
      st.ef = Math.min(2.5, (st.ef || 2.5) + 0.1);
      if (st.tc >= MASTERY_MIN_CORRECT) {
        delete progress.weak[currentModule][bid];
        if (currentQuestion._masteryReview && beforeTc >= MASTERY_MIN_CORRECT) {
          st.rev    = (Number(st.rev) || 0) + 1;
          st.nextAt = ms + reviewGapAfterPhase(Number(st.rev), st.ef);
        } else if (st.tc === MASTERY_MIN_CORRECT) {
          st.rev    = 0;
          st.nextAt = ms + MASTERY_FIRST_GAP;
        }
      }
    }
    saveProgress();
    registerWeak(bid, ok);
    award(ok);
    refreshMeta();

    // 抖动效果（答错时）
    if (!ok) {
      const card = document.getElementById("question-card");
      card.classList.add("shake");
      setTimeout(() => card.classList.remove("shake"), 500);
    }

    // 反馈区
    const fb    = document.getElementById("feedback");
    const title = document.getElementById("feedback-title");
    const ans   = document.getElementById("feedback-answer");
    const exp   = document.getElementById("feedback-exp");
    fb.classList.remove("hidden");

    const streak = progress[currentModule].streak;
    const isMatch = currentQuestion.type === "match";

    title.textContent = ok
      ? okMsg(streak)
      : isMatch ? "连线完成，但有误配" : WRONG_MSGS[Math.floor(Math.random() * WRONG_MSGS.length)];
    title.className = "feedback-title " + (ok ? "ok" : "bad");
    ans.textContent = ok ? "" : "正确答案：" + rightText;

    // 情绪鼓励 + 解析
    const encourage = ok ? pickRandom(CORRECT_ENCOURAGE) : pickRandom(WRONG_ENCOURAGE);
    exp.textContent = "";
    const fbLabel = document.createElement("span");
    fbLabel.className = "fb-label " + (ok ? "ok" : "bad");
    fbLabel.textContent = encourage;
    exp.appendChild(fbLabel);
    exp.appendChild(document.createTextNode(currentQuestion.explanation));

    // 禁用所有交互
    ["fill-input", "fill-submit"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
    document.querySelectorAll(".match-item, .multi-opt, .order-step, .tf-btn")
      .forEach(el => { el.style.pointerEvents = "none"; });

    document.getElementById("btn-next").onclick = renderQuestion;
  }

  // ─── 首页进度更新 + 事件绑定 ────────────────────────────
  document.querySelectorAll(".module-card").forEach(btn => {
    btn.addEventListener("click", () => {
      currentModule = btn.dataset.module;
      showPlay();
    });
  });

  document.getElementById("btn-back").addEventListener("click", showHome);

  document.getElementById("btn-reset").addEventListener("click", () => {
    if (confirm("确定清空所有进度、连胜与错题记录？")) {
      progress = defaultProgress();
      saveProgress();
      showHome();
    }
  });

  // 初始化
  refreshHomeStats();
})();
