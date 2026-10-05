import { currentIM, recoverSession } from './services/im/client';
App({
    onShow() { const session = currentIM(); if (session)
        void recoverSession(session).catch(() => { }); },
    onHide() { currentIM()?.client.disconnect(); }
});
