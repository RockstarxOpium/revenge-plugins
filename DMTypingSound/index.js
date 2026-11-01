(() => {
    // DM Typing Sound for Revenge (Vendetta-format plugin)
    // Plays a sound (and/or vibrates) when someone starts typing to you in DMs.
    // NOTE: this file must start with "(" on line 1 — Revenge wraps it in `return ...`.

    const { metro, plugin, storage: storageApi, ui } = vendetta;
    const { React, ReactNative: RN, FluxDispatcher } = metro.common;
    const { Forms } = ui.components;
    const { FormSection, FormRow, FormSwitchRow, FormInput, FormDivider, FormText } = Forms;

    const ChannelStore = metro.findByStoreName("ChannelStore");
    const UserStore = metro.findByStoreName("UserStore");
    const SelectedChannelStore = metro.findByStoreName("SelectedChannelStore");
    const RelationshipStore = metro.findByStoreName("RelationshipStore");

    const SoundManager = RN.NativeModules.DCDSoundManager ?? RN.NativeModules.NativeSoundManager;

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

    const lastPlayed = new Map();
    let soundId = 0;
    let preparedUrl = null;
    let duration = 1500;
    let stopTimer = null;

    function soundUrl() {
        if (store.sound === "none") return null;
        if (store.sound === "custom") return store.customUrl.trim() || null;
        // plugin.id is the URL the plugin was installed from (ends with "/")
        return `${plugin.id}sounds/${store.sound}.wav`;
    }

    function prepare() {
        const url = soundUrl();
        if (!SoundManager || !url || url === preparedUrl) return;
        soundId = 7300 + Math.floor(Math.random() * 1000);
        preparedUrl = url;
        try {
            SoundManager.prepare(url, "notification", soundId, (err, meta) => {
                if (err) { preparedUrl = null; return; }
                if (meta?.duration) duration = meta.duration;
            });
        } catch {
            preparedUrl = null;
        }
    }

    function play() {
        if (store.vibrate || store.sound === "none") RN.Vibration.vibrate(store.sound === "none" ? [0, 40, 60, 40] : 35);
        if (!SoundManager || !soundUrl()) return;
        if (preparedUrl !== soundUrl()) prepare();
        try {
            if (stopTimer) { clearTimeout(stopTimer); SoundManager.stop(soundId); }
            SoundManager.play(soundId);
            stopTimer = setTimeout(() => { SoundManager.stop(soundId); stopTimer = null; }, Math.max(duration, 300) + 100);
        } catch { }
    }

    function onTypingStart({ channelId, userId }) {
        try {
            if (userId === UserStore.getCurrentUser()?.id) return;

            const channel = ChannelStore.getChannel(channelId);
            if (!channel) return;
            const isDM = channel.type === 1;
            const isGroup = channel.type === 3;
            if (!isDM && !(isGroup && store.groupDMs)) return;
            if (store.friendsOnly && !RelationshipStore.isFriend(userId)) return;

            if (store.when === "notHere") {
                const lookingAtIt = SelectedChannelStore.getChannelId() === channelId;
                const appActive = RN.AppState.currentState === "active";
                if (lookingAtIt && appActive) return;
            }

            const now = Date.now();
            const cd = Math.max(0, Number(store.cooldown) || 0) * 1000;
            if (now - (lastPlayed.get(channelId) ?? 0) < cd) return;
            lastPlayed.set(channelId, now);

            play();
        } catch (e) {
            vendetta.logger?.error?.("DMTypingSound error", e);
        }
    }

    function onMessageCreate({ message }) {
        // Once they actually send, the next typing burst can play again right away
        if (message?.channel_id) lastPlayed.delete(message.channel_id);
    }

    function Settings() {
        storageApi.useProxy(store);
        const h = React.createElement;

        return h(RN.ScrollView, { style: { flex: 1 } },
            h(FormSection, { title: "Sound" },
                ...Object.entries(PRESETS).map(([key, label]) =>
                    h(FormRow, {
                        key,
                        label,
                        trailing: store.sound === key ? h(FormText, null, "✓") : null,
                        onPress: () => { store.sound = key; prepare(); }
                    })
                ),
                store.sound === "custom" && h(FormInput, {
                    title: "Custom sound URL (.mp3 / .ogg / .wav)",
                    placeholder: "https://files.catbox.moe/abc123.mp3",
                    value: store.customUrl,
                    onChange: v => { store.customUrl = v; }
                }),
                h(FormRow, {
                    label: "▶  Test sound",
                    onPress: () => { preparedUrl = null; prepare(); setTimeout(play, 600); }
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
                    value: store.groupDMs,
                    onValueChange: v => { store.groupDMs = v; }
                }),
                h(FormDivider),
                h(FormSwitchRow, {
                    label: "Only for friends",
                    value: store.friendsOnly,
                    onValueChange: v => { store.friendsOnly = v; }
                }),
                h(FormDivider),
                h(FormSwitchRow, {
                    label: "Vibrate too",
                    value: store.vibrate,
                    onValueChange: v => { store.vibrate = v; }
                }),
                h(FormInput, {
                    title: "Cooldown per chat (seconds)",
                    keyboardType: "numeric",
                    value: String(store.cooldown),
                    onChange: v => { store.cooldown = v.replace(/[^0-9]/g, ""); }
                })
            ),
            h(FormText, { style: { margin: 16, opacity: 0.6 } },
                "Built-in sounds load from the computer you installed the plugin from, so keep that running the first time Discord opens. " +
                "For sounds that always work, upload a sound to catbox.moe and use Custom URL."
            )
        );
    }

    return {
        onLoad() {
            FluxDispatcher.subscribe("TYPING_START", onTypingStart);
            FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
            prepare();
        },
        onUnload() {
            FluxDispatcher.unsubscribe("TYPING_START", onTypingStart);
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
            try { if (stopTimer) SoundManager?.stop(soundId); } catch { }
            lastPlayed.clear();
        },
        settings: Settings
    };
})()
