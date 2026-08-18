export const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30];

export function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function nextReviewDate(step = 0, from = new Date()) {
  const date = new Date(from);
  const interval = REVIEW_INTERVALS[Math.min(Math.max(step, 0), REVIEW_INTERVALS.length - 1)];
  date.setDate(date.getDate() + interval);
  return date.toISOString();
}

export function updateProgress(progress = {}, grade, now = new Date()) {
  const safeGrade = grade === "again" ? "again" : grade === "hard" ? "hard" : "good";
  const currentStep = Number.isInteger(progress.reviewStep) ? progress.reviewStep : 0;
  const reviewStep = safeGrade === "again" ? 0 : safeGrade === "hard" ? Math.max(0, currentStep) : Math.min(currentStep + 1, REVIEW_INTERVALS.length - 1);
  const attempts = Number(progress.attempts || 0) + 1;
  const correct = Number(progress.correct || 0) + (safeGrade === "good" ? 1 : 0);
  return {
    ...progress,
    reviewStep,
    attempts,
    correct,
    mastery: Math.round((correct / attempts) * 100),
    lastStudied: now.toISOString(),
    nextReview: safeGrade === "again" ? now.toISOString() : nextReviewDate(reviewStep, now)
  };
}

export function dueWordIds(progressMap = {}, now = new Date()) {
  const time = now.getTime();
  return Object.entries(progressMap)
    .filter(([, progress]) => progress.nextReview && new Date(progress.nextReview).getTime() <= time)
    .map(([id]) => id);
}

export function catalogStats(chapters = [], progressMap = {}) {
  const words = chapters.flatMap(chapter => chapter.words || []);
  const studied = words.filter(word => progressMap[word.id]?.attempts).length;
  const mastered = words.filter(word => Number(progressMap[word.id]?.mastery || 0) >= 80).length;
  const average = studied
    ? Math.round(words.reduce((sum, word) => sum + Number(progressMap[word.id]?.mastery || 0), 0) / studied)
    : 0;
  return { total: words.length, studied, mastered, average };
}

export function weakWordsStudiedOn(words = [], progressMap = {}, targetDate = new Date(), limit = 3) {
  const dateKey = localDateKey(targetDate);
  return words
    .filter(word => {
      const progress = progressMap[word.id];
      return progress?.lastStudied && localDateKey(progress.lastStudied) === dateKey;
    })
    .sort((left, right) => {
      const leftProgress = progressMap[left.id];
      const rightProgress = progressMap[right.id];
      return Number(leftProgress?.mastery || 0) - Number(rightProgress?.mastery || 0)
        || new Date(rightProgress.lastStudied) - new Date(leftProgress.lastStudied);
    })
    .slice(0, Math.max(1, limit));
}

function englishList(items) {
  if (items.length < 2) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

export function buildRevisionSentence(terms = []) {
  const cleanTerms = [...new Set(terms.map(term => String(term || "").trim()).filter(Boolean))].slice(0, 3);
  if (!cleanTerms.length) {
    return {
      english: "Every word remembered today becomes part of tomorrow's journey.",
      chinese: "今天记住的每一个词，都会成为明日旅程的一部分。"
    };
  }
  const quoted = cleanTerms.map(term => `“${term}”`);
  return {
    english: `Today, I will turn ${englishList(quoted)} from uncertain memories into words I can truly use.`,
    chinese: `今天，我会让 ${cleanTerms.join("、")} 从模糊的记忆，变成真正能够使用的表达。`
  };
}
