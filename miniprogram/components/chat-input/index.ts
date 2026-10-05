Component({ properties: { busy: { type: Boolean, value: false } }, data: { text: '' }, methods: { onInput(e: {
            detail: {
                value: string;
            };
        }) { this.setData({ text: e.detail.value }); }, onSend() { const text = this.data.text.trim(); if (!text || this.properties.busy)
            return; this.triggerEvent('send', { text }); this.setData({ text: '' }); }, onImage() { if (!this.properties.busy)
            this.triggerEvent('image'); } } });
