const SDK_URL = "https://static.cloudbase.net/cloudbase-js-sdk/3.0.1/cloudbase.full.js";
const OUTBOX_KEY = "wordsail-cloud-outbox-v1";
const PENDING_STATE_KEY = "wordsail-cloud-state-v1";

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function timestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function newestProgress(localProgress, remoteProgress) {
  const localTime = timestamp(localProgress?.updatedAt || localProgress?.lastStudied);
  const remoteTime = timestamp(remoteProgress?.updatedAt || remoteProgress?.lastStudied);
  return remoteTime > localTime ? remoteProgress : localProgress;
}

export function mergeLearningSnapshots(local = {}, remote = {}) {
  const localProgress = safeObject(local.progress);
  const remoteProgress = safeObject(remote.progress);
  const progress = {};
  for (const wordId of new Set([...Object.keys(localProgress), ...Object.keys(remoteProgress)])) {
    progress[wordId] = newestProgress(localProgress[wordId], remoteProgress[wordId]);
  }
  const localUpdatedAt = timestamp(local.updatedAt);
  const remoteUpdatedAt = timestamp(remote.updatedAt);
  return {
    progress,
    activityDates: [...new Set([...(local.activityDates || []), ...(remote.activityDates || [])])].sort(),
    activeChapterId: remoteUpdatedAt > localUpdatedAt
      ? String(remote.activeChapterId || local.activeChapterId || "")
      : String(local.activeChapterId || remote.activeChapterId || ""),
    updatedAt: new Date(Math.max(localUpdatedAt, remoteUpdatedAt, Date.now())).toISOString(),
    schemaVersion: 1
  };
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "") || fallback; }
  catch { return fallback; }
}

function loadSdk() {
  if (globalThis.cloudbase) return Promise.resolve(globalThis.cloudbase);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SDK_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(globalThis.cloudbase), { once: true });
      existing.addEventListener("error", () => reject(new Error("CloudBase SDK 加载失败")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve(globalThis.cloudbase);
    script.onerror = () => reject(new Error("CloudBase SDK 加载失败"));
    document.head.append(script);
  });
}

function cleanCloudConfig(config = {}) {
  return {
    envId: String(config.envId || "").trim(),
    region: String(config.region || "ap-shanghai").trim(),
    accessKey: String(config.accessKey || "").trim()
  };
}

export class WordSailCloudSync {
  constructor(config = {}, callbacks = {}) {
    this.config = cleanCloudConfig(config);
    this.callbacks = callbacks;
    this.enabled = Boolean(this.config.envId);
    this.ready = false;
    this.app = null;
    this.auth = null;
    this.db = null;
    this.userId = "";
    this.profileId = "";
    this.saveTimer = null;
    this.latestSnapshot = null;
  }

  setStatus(mode, detail = "") {
    this.callbacks.onStatus?.({ mode, detail, enabled: this.enabled, userId: this.userId });
  }

  async init(localSnapshot = {}) {
    if (!this.enabled) {
      this.setStatus("disabled");
      return localSnapshot;
    }
    this.setStatus("connecting");
    try {
      const cloudbase = await loadSdk();
      const options = { env: this.config.envId, region: this.config.region, auth: { detectSessionInUrl: true } };
      if (this.config.accessKey) options.accessKey = this.config.accessKey;
      this.app = cloudbase.init(options);
      this.auth = this.app.auth;
      this.db = this.app.database();

      let sessionResult = await this.auth.getSession();
      if (sessionResult?.error) throw sessionResult.error;
      if (!sessionResult?.data?.session) {
        sessionResult = await this.auth.signInAnonymously();
        if (sessionResult?.error) throw sessionResult.error;
      }
      this.userId = String(sessionResult?.data?.session?.user?.id || sessionResult?.data?.user?.id || "");
      if (!this.userId) throw new Error("未取得云端用户身份");
      this.ready = true;

      const remoteSnapshot = await this.readProfile();
      const merged = mergeLearningSnapshots(localSnapshot, remoteSnapshot || {});
      this.callbacks.onRemoteState?.(merged);
      await this.writeProfile(merged);
      await this.flushOutbox();
      this.setStatus("synced");
      return merged;
    } catch (error) {
      this.ready = false;
      this.setStatus("error", error?.message || "云端暂不可用");
      return localSnapshot;
    }
  }

  async readProfile() {
    const result = await this.db.collection("learning_profiles")
      .where({ _openid: this.userId })
      .limit(1)
      .get();
    const profile = result?.data?.[0];
    if (!profile) return null;
    this.profileId = String(profile._id || "");
    return profile;
  }

  async writeProfile(snapshot) {
    const payload = {
      progress: safeObject(snapshot.progress),
      activityDates: Array.isArray(snapshot.activityDates) ? snapshot.activityDates : [],
      activeChapterId: String(snapshot.activeChapterId || ""),
      updatedAt: snapshot.updatedAt || new Date().toISOString(),
      schemaVersion: 1
    };
    if (this.profileId) {
      await this.db.collection("learning_profiles").doc(this.profileId).update(payload);
    } else {
      const result = await this.db.collection("learning_profiles").add(payload);
      this.profileId = String(result?.id || result?._id || "");
    }
    localStorage.removeItem(PENDING_STATE_KEY);
  }

  saveLearningState(snapshot) {
    if (!this.enabled) return;
    this.latestSnapshot = { ...snapshot, updatedAt: snapshot.updatedAt || new Date().toISOString(), schemaVersion: 1 };
    localStorage.setItem(PENDING_STATE_KEY, JSON.stringify(this.latestSnapshot));
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      if (!this.ready) return this.setStatus("queued");
      try {
        await this.writeProfile(this.latestSnapshot);
        this.setStatus("synced");
      } catch (error) {
        this.setStatus("queued", error?.message || "等待网络恢复");
      }
    }, 650);
  }

  queue(kind, payload) {
    const outbox = loadJson(OUTBOX_KEY, []);
    outbox.push({ kind, payload, queuedAt: new Date().toISOString() });
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.slice(-200)));
    this.setStatus("queued");
  }

  async record(kind, payload) {
    if (!this.enabled) return false;
    if (!this.ready) {
      this.queue(kind, payload);
      return true;
    }
    try {
      await this.db.collection(kind === "feedback" ? "feedback" : "product_events").add({
        ...payload,
        createdAt: payload.createdAt || new Date().toISOString()
      });
      return true;
    } catch {
      this.queue(kind, payload);
      return true;
    }
  }

  recordEvent(payload) { return this.record("event", payload); }
  recordFeedback(payload) { return this.record("feedback", payload); }

  async flushOutbox() {
    if (!this.ready) return;
    const pendingState = loadJson(PENDING_STATE_KEY, null);
    if (pendingState) await this.writeProfile(pendingState);
    const outbox = loadJson(OUTBOX_KEY, []);
    const remaining = [];
    for (const item of outbox) {
      try {
        await this.db.collection(item.kind === "feedback" ? "feedback" : "product_events").add({
          ...item.payload,
          createdAt: item.payload.createdAt || item.queuedAt || new Date().toISOString()
        });
      } catch {
        remaining.push(item);
      }
    }
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(remaining));
  }
}

export function createCloudSync(config, callbacks) {
  return new WordSailCloudSync(config, callbacks);
}
