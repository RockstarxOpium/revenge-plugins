import { storage } from "@revenge-mod/plugin";
import { flux, findByProps } from "@revenge-mod/discord/modules";

const MessageStore = findByProps("getMessage", "getMessages");

storage.logs ??= [];

function handleMessageDelete({ id, channelId }) {
    const message = MessageStore.getMessage(channelId, id);
    
    if (message && message.content) {
        storage.logs.push({
            author: message.author.username,
            content: message.content,
            time: new Date().toLocaleString(),
            channelId: channelId,
        });

        if (storage.logs.length > 500) storage.logs.shift();
    }
}

export default function patch() {
    flux.dispatcher.subscribe("MESSAGE_DELETE", handleMessageDelete);
    
    return () => {
        flux.dispatcher.unsubscribe("MESSAGE_DELETE", handleMessageDelete);
    };
}
