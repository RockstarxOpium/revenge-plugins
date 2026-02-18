import { storage } from "@revenge-mod/plugin";
import { flux, findByProps } from "@revenge-mod/discord/modules";

const MessageStore = findByProps("getMessage", "getMessages");

storage.logs ??= [];

const handleMessageDelete = ({ id, channelId }) => {
    const message = MessageStore.getMessage(channelId, id);
    
    if (message && message.content) {
        storage.logs.push({
            id: message.id,
            author: message.author.username,
            content: message.content,
            timestamp: new Date().toLocaleString(),
            channelId: channelId,
            deleted: true
        });

        if (storage.logs.length > 500) {
            storage.logs.shift();
        }
    }
};

export default {
    onLoad: () => {
        flux.dispatcher.subscribe("MESSAGE_DELETE", handleMessageDelete);
    },
    onUnload: () => {
        flux.dispatcher.unsubscribe("MESSAGE_DELETE", handleMessageDelete);
    }
};
