(() => {
    // DM Typing Sound for Revenge (Vendetta-format plugin)
    // Plays a sound (and/or vibrates) when someone starts typing to you in DMs.
    // NOTE: this file must start with "(" on line 1 — Revenge wraps it in `return ...`.
    //
    // Safety rule for Discord's native sound player (DCDSoundManager):
    // NEVER call play() or stop() on a sound id that hasn't finished prepare().
    // Doing so throws inside native Android code, which crashes the whole app
    // and cannot be caught from JavaScript. Everything below enforces that.

    const { metro, plugin, storage: storageApi, ui } = vendetta;
    const { React, ReactNative: RN, FluxDispatcher } = metro.common;
    const { Forms } = ui.components;
    const { FormSection, FormRow, FormSwitchRow, FormInput, FormDivider, FormText } = Forms;
    const toast = msg => { try { ui.toasts.showToast(msg); } catch { } };
    const log = (...a) => { try { vendetta.logger?.log?.("[DMTypingSound]", ...a); } catch { } };

    const ChannelStore = metro.findByStoreName("ChannelStore");
    const UserStore = metro.findByStoreName("UserStore");
    const SelectedChannelStore = metro.findByStoreName("SelectedChannelStore");
    const RelationshipStore = metro.findByStoreName("RelationshipStore");

    const SoundManager = RN.NativeModules?.DCDSoundManager ?? null;

    const store = plugin.storage;
    store.sound ??= "blip";          // blip | chime | bubble | emo | custom | none
    store.customUrl ??= "";
    store.vibrate ??= false;
    store.when ??= "notHere";        // notHere | always
    store.groupDMs ??= false;
    store.friendsOnly ??= false;
    store.cooldown ??= 20;

    const PRESETS = {
        blip: "Soft blip",
        chime: "Two-tone chime",
        bubble: "Bubble pop",
        emo: "Emo trap (dreamy pluck + 808)",
        custom: "Custom URL",
        none: "No sound (vibrate only)"
    };

    const LOAD_TIMEOUT_MS = 10000;
    let unloaded = false;

    /* ---------------------------------------------------------------- *
     *  Sound loading / playing                                          *
     * ---------------------------------------------------------------- */

    /**
     * One entry per URL:
     *  state: "loading" | "ready" | "failed"
     *  id: native sound id
     *  duration: ms
     *  playing: whether we think it's playing (so we only stop() a ready+playing sound)
     *  pending: play once ready
     */
    const sounds = new Map();
    let nextId = 47000 + Math.floor(Math.random() * 1000);

    function currentUrl() {
        if (store.sound === "none") return null;
        if (store.sound === "custom") {
            const u = String(store.customUrl || "").trim();
            return /^https:\/\/\S+$/i.test(u) ? u : null;
        }
        // plugin.id is the https URL the plugin was installed from (ends with "/")
        return `${plugin.id}sounds/${store.sound}.wav`;
    }

    function load(url, notify = false) {
        if (!SoundManager || !url) return null;
        const existing = sounds.get(url);
        if (existing && existing.state !== "failed") return existing;

        const s = { id: nextId++, state: "loading", duration: 1000, playing: false, pending: false, timer: null };
        sounds.set(url, s);

        const finish = (ok, meta) => {
            if (s.state !== "loading") return; // already timed out / finished
            clearTimeout(s.timer);
            if (!ok) {
                s.state = "failed";
                s.pending = false;
                log("failed to load", url);
                if (notify) toast("Couldn't load that sound. Check the link or your connection.");
                return;
            }
            s.state = "ready";
            const d = Number(meta?.duration);
            if (d > 0 && d < 30000) s.duration = d;
            log("ready", url, s.duration + "ms");
            if (s.pending && !unloaded) {
                s.pending = false;
                // Only play if it's still the sound the user has selected
                if (currentUrl() === url) playLoaded(s);
            }
        };

        s.timer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS);

        try {
            SoundManager.prepare(url, "notification", s.id, (err, meta) => {
                // Some builds pass (error, meta), some (null, meta). Treat "no meta + error" as failure.
                finish(!(err && !meta), meta);
            });
        } catch (e) {
            log("prepare threw", e);
            finish(false);
        }
        return s;
    }

    function playLoaded(s) {
        // Only ever touch the native player for a sound that is fully ready.
        if (!s || s.state !== "ready" || unloaded) return;
        try {
            if (s.playing) {
                SoundManager.stop(s.id);
                s.playing = false;
            }
            SoundManager.play(s.id);
            s.playing = true;
            clearTimeout(s.stopTimer);
            s.stopTimer = setTimeout(() => {
                if (s.playing && s.state === "ready") {
                    try { SoundManager.stop(s.id); } catch { }
                }
                s.playing = false;
            }, s.duration + 150);
        } catch (e) {
            log("play threw", e);
            s.playing = false;
        }
    }

    /** Play the selected sound. If it isn't loaded yet, it plays as soon as it is. */
    function playSound(notify = false) {
        const url = currentUrl();
        if (!url) {
            if (notify && store.sound === "custom") toast("Enter a link starting with https://");
            return;
        }
        if (!SoundManager) {
            if (notify) toast("This Discord version has no sound player — try Vibrate instead.");
            return;
        }
        const s = load(url, notify);
        if (!s) return;
        if (s.state === "ready") playLoaded(s);
        else if (s.state === "loading") {
            s.pending = true;
            if (notify) toast("Loading sound…");
        }
    }

    function vibrate() {
        try {
            if (store.sound === "none") RN.Vibration.vibrate([0, 40, 60, 40]);
            else RN.Vibration.vibrate(35);
        } catch { }
    }

    function alertUser(notify = false) {
        if (store.vibrate || store.sound === "none") vibrate();
        playSound(notify);
    }

    /* ---------------------------------------------------------------- *
     *  Discord events                                                   *
     * ---------------------------------------------------------------- */

    const lastPlayed = new Map();

    function onTypingStart(event) {
        try {
            const { channelId, userId } = event ?? {};
            if (!channelId || !userId) return;
            if (userId === UserStore?.getCurrentUser?.()?.id) return;

            const channel = ChannelStore?.getChannel?.(channelId);
            if (!channel) return;
            const isDM = channel.type === 1;
            const isGroup = channel.type === 3;
            if (!isDM && !(isGroup && store.groupDMs)) return;
            if (store.friendsOnly && !RelationshipStore?.isFriend?.(userId)) return;

            if (store.when !== "always") {
                const lookingAtIt = SelectedChannelStore?.getChannelId?.() === channelId;
                const appActive = RN.AppState?.currentState === "active";
                if (lookingAtIt && appActive) return;
            }

            const now = Date.now();
            const cd = Math.max(0, Number(store.cooldown) || 0) * 1000;
            if (now - (lastPlayed.get(channelId) ?? 0) < cd) return;
            lastPlayed.set(channelId, now);

            alertUser(false);
        } catch (e) {
            log("typing handler error", e);
        }
    }

    function onMessageCreate(event) {
        try {
            // Once they actually send, the next typing burst can play again right away
            const id = event?.message?.channel_id ?? event?.channelId;
            if (id) lastPlayed.delete(id);
        } catch { }
    }

    /* ---------------------------------------------------------------- *
     *  Settings page                                                    *
     * ---------------------------------------------------------------- */

    function Settings() {
        storageApi.useProxy(store);
        const h = React.createElement;

        const rows = Object.entries(PRESETS).map(([key, label]) =>
            h(FormRow, {
                key,
                label: (store.sound === key ? "✓  " : "     ") + label,
                onPress: () => {
                    store.sound = key;
                    const url = currentUrl();
                    if (url) load(url); // preload so Test is instant
                }
            })
        );

        return h(RN.ScrollView, { style: { flex: 1 } },
            h(FormSection, { title: "Sound" },
                ...rows,
                store.sound === "custom" ? h(FormInput, {
                    title: "Custom sound link (https, .mp3 / .ogg / .wav)",
                    placeholder: "https://files.catbox.moe/abc123.mp3",
                    value: String(store.customUrl ?? ""),
                    onChange: v => { store.customUrl = v; }
                }) : null,
                h(FormRow, {
                    label: "▶  Test sound",
                    onPress: () => alertUser(true)
                })
            ),
            h(FormSection, { title: "When" },
                h(FormSwitchRow, {
                    label: "Play even when I'm looking at that DM",
                    value: store.when === "always",
                    onValueChange: v => { store.when = v ? "always" : "notHere"; }
                }),
                h(FormDivider),
                h(FormSwitchRow, {
                    label: "Also for group DMs",
                    value: !!store.groupDMs,
                    onValueChange: v => { store.groupDMs = v; }
                }),
                h(FormDivider),
                h(FormSwitchRow, {
                    label: "Only for friends",
                    value: !!store.friendsOnly,
                    onValueChange: v => { store.friendsOnly = v; }
                }),
                h(FormDivider),
                h(FormSwitchRow, {
                    label: "Vibrate too",
                    value: !!store.vibrate,
                    onValueChange: v => { store.vibrate = v; }
                }),
                h(FormInput, {
                    title: "Cooldown per chat (seconds)",
                    keyboardType: "numeric",
                    value: String(store.cooldown ?? 20),
                    onChange: v => { store.cooldown = String(v).replace(/[^0-9]/g, "").slice(0, 4); }
                })
            ),
            h(FormText, { style: { margin: 16, opacity: 0.6 } },
                "The first play of a sound may take a moment while it downloads. After that it plays instantly."
            )
        );
    }

    /* ---------------------------------------------------------------- */

    return {
        onLoad() {
            unloaded = false;
            FluxDispatcher.subscribe("TYPING_START", onTypingStart);
            FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
            const url = currentUrl();
            if (url) load(url); // preload in the background
        },
        onUnload() {
            unloaded = true;
            FluxDispatcher.unsubscribe("TYPING_START", onTypingStart);
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
            for (const s of sounds.values()) {
                clearTimeout(s.timer);
                clearTimeout(s.stopTimer);
                s.pending = false;
                if (s.state === "ready" && s.playing) {
                    try { SoundManager.stop(s.id); } catch { }
                }
                s.playing = false;
            }
            lastPlayed.clear();
        },
        settings: Settings
    };
})()
