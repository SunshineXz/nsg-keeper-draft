/* Two interchangeable backends behind one small interface, so the room logic
   in app.js never knows which one it is talking to:

     watch(path, cb)      cb(value | null) on every change under that path
     update(updates)      atomic multi-path write; TS anywhere = server time
     push(path, value)    append one child under path (chat)
     presence(value)      publish "I am here", removed when this page goes away
     serverNow()          ms, corrected for this device's clock skew
     onConnection(cb)     cb(true | false)
     authReady()          resolves once any saved sign-in is restored
     claimTeam(team, key) prove a team link; resolves true/false
     commishSignIn()      Google sign-in; resolves true if it's the commissioner
     isCommish()          resolves true/false without prompting
     readSecrets()        {teamId: token} (commissioner only)
     get(path)            one value, as the rules allow this user to read it

   Firebase is the real thing. Local mode (?local=1) keeps everything in this
   browser's localStorage and syncs tabs with BroadcastChannel - it exists so
   the room can be tried and tested without a Firebase project. */

export const TS = Object.freeze({ serverTime: true });
const FIREBASE_VERSION = "12.3.0";

function mapTS(v, stamp) {
  if (v === TS) return stamp();
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = mapTS(x, stamp);
    return o;
  }
  return v;
}

export async function connectFirebase(cfg) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [{ initializeApp }, A, D] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-database.js`),
  ]);
  const app = initializeApp(cfg);
  const auth = A.getAuth(app);
  const db = D.getDatabase(app);
  let offset = 0, presArmed = null;
  D.onValue(D.ref(db, ".info/serverTimeOffset"), s => { offset = s.val() || 0; });

  const api = {
    kind: "firebase",
    watch(path, cb, onErr) {
      return D.onValue(D.ref(db, path), s => cb(s.val()), e => onErr && onErr(e));
    },
    onConnection(cb) { D.onValue(D.ref(db, ".info/connected"), s => cb(!!s.val())); },
    serverNow: () => Date.now() + offset,
    update: u => D.update(D.ref(db), mapTS(u, () => D.serverTimestamp())),
    push: (path, v) => D.push(D.ref(db, path), mapTS(v, () => D.serverTimestamp())),
    // Signed in = an owner on their team link, or the commissioner. A watcher
    // has no account, so nothing to publish. The server drops the entry when
    // this browser's socket goes, which is what makes the list trustworthy.
    async presence(v) {
      if (!auth.currentUser) return;
      const r = D.ref(db, `presence/${auth.currentUser.uid}`);
      if (presArmed !== auth.currentUser.uid) {            // the SDK keeps it armed across reconnects
        presArmed = auth.currentUser.uid;
        await D.onDisconnect(r).remove();
      }
      await D.set(r, mapTS(v, () => D.serverTimestamp()));
    },
    authReady: () => new Promise(res => { const un = A.onAuthStateChanged(auth, u => { un(); res(u); }); }),
    async claimTeam(team, key) {
      try {
        if (!auth.currentUser) await A.signInAnonymously(auth);
        await D.set(D.ref(db, `claims/${auth.currentUser.uid}`), { team, token: key });
        return true;
      } catch (e) {
        console.warn("claim failed", e);
        return false;
      }
    },
    async commishSignIn() {
      await A.signInWithPopup(auth, new A.GoogleAuthProvider());
      return api.isCommish();
    },
    async isCommish() {
      const u = auth.currentUser;
      if (!u || u.isAnonymous) return false;
      try { await D.get(D.ref(db, "secrets/teams")); return true; } catch { return false; }
    },
    readSecrets: async () => (await D.get(D.ref(db, "secrets/teams"))).val() || {},
    get: async path => (await D.get(D.ref(db, path))).val(),
    signOut: () => A.signOut(auth),
  };
  return api;
}

export function connectLocal(opts) {
  const KEY = "nsgDraftLocal_v1";
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("nsgDraftLocal") : null;
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
  const subs = [];
  const emit = () => { const t = load(); subs.forEach(({ path, cb }) => cb(getAt(t, path) ?? null)); };
  const tabId = Math.random().toString(36).slice(2);
  let presArmed = false;
  if (bc) bc.onmessage = emit;
  window.addEventListener("storage", e => { if (e.key === KEY) emit(); });

  function getAt(tree, path) {
    return path.split("/").reduce((n, k) => (n == null ? undefined : n[k]), tree);
  }
  function setAt(tree, path, val) {
    const ks = path.split("/");
    let n = tree;
    for (const k of ks.slice(0, -1)) { if (typeof n[k] !== "object" || n[k] === null) n[k] = {}; n = n[k]; }
    if (val === null || val === undefined) delete n[ks[ks.length - 1]];
    else n[ks[ks.length - 1]] = val;
  }

  return {
    kind: "local",
    watch(path, cb) { subs.push({ path, cb }); setTimeout(() => cb(getAt(load(), path) ?? null), 0); },
    onConnection(cb) { cb(true); },
    serverNow: () => Date.now(),
    async update(u) {
      const tree = load();
      const now = Date.now();
      // The one server rule that matters for races (two tabs auto-picking at
      // the buzzer): a pick slot can only be filled once.
      for (const [k, v] of Object.entries(u)) {
        if (/^draft\/picks\/\d+$/.test(k) && v !== null && getAt(tree, k) != null && !opts.commish) {
          const err = new Error("PERMISSION_DENIED: pick already made"); err.code = "PERMISSION_DENIED"; throw err;
        }
      }
      for (const [k, v] of Object.entries(u)) setAt(tree, k, mapTS(v, () => now));
      localStorage.setItem(KEY, JSON.stringify(tree));
      if (bc) bc.postMessage(1);
      emit();
    },
    async push(path, v) { await this.update({ [`${path}/${Date.now().toString(36)}-${tabId}`]: v }); },
    async presence(v) {
      if (!presArmed) {
        presArmed = true;
        window.addEventListener("pagehide", () => this.update({ [`presence/${tabId}`]: null }), { once: true });
      }
      await this.update({ [`presence/${tabId}`]: v });
    },
    authReady: async () => null,
    claimTeam: async () => true,
    async commishSignIn() { opts.commish = true; return true; },
    isCommish: async () => !!opts.commish,
    readSecrets: async () => (load().secrets || {}).teams || {},
    get: async path => { const v = getAt(load(), path); return v === undefined ? null : v; },
    signOut: async () => {},
  };
}
