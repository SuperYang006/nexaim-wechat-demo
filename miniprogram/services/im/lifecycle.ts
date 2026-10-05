export class SessionGate {
    active = true;
    private listeners: (() => void)[] = [];
    add(unsubscribe: () => void) {
        if (this.active)
            this.listeners.push(unsubscribe);
        else
            unsubscribe();
    }
    assert() { if (!this.active)
        throw new Error('SESSION_EXPIRED'); }
    dispose() {
        if (!this.active)
            return;
        this.active = false;
        for (const off of this.listeners.splice(0))
            off();
    }
}

// Native pickers may hide the page. Pause its work until the same page returns;
// unload/account changes cancel waiters so stale results cannot update another UI.
export class ForegroundTask {
    private active = true;
    private visible = true;
    private waiters: ((ready: boolean) => void)[] = [];
    hide() { this.visible = false; }
    show() {
        if (!this.active) return;
        this.visible = true;
        this.settle(true);
    }
    cancel() {
        this.active = false;
        this.settle(false);
    }
    async ready(): Promise<void> {
        while (this.active) {
            const shown = await (this.visible ? Promise.resolve(true) :
                new Promise<boolean>(resolve => this.waiters.push(resolve)));
            if (!shown || this.visible) return;
            // A second hide may occur before the first show continuation runs.
        }
    }
    private settle(ready: boolean) {
        for (const resolve of this.waiters.splice(0)) resolve(ready);
    }
}
