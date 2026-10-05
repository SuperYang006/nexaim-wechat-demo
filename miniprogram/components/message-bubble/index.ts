Component({ properties: { message: { type: Object, value: {} as {
                clientMessageId?: string;
                mediaAssetId?: string;
            } } }, methods: { onRetry() { this.triggerEvent('retry', { id: this.properties.message.clientMessageId }); }, onPreview() { this.triggerEvent('preview', { id: this.properties.message.mediaAssetId }); }, onImageError() { this.triggerEvent('imageerror', { id: this.properties.message.mediaAssetId }); }, onReload() { this.triggerEvent('reload', { id: this.properties.message.mediaAssetId }); } } });
