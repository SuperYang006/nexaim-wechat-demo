import { createApp } from './app';
import { readConfig } from './config';
try {
    const config = readConfig(process.env);
    const app = createApp(config);
    await app.listen({ port: config.port, host: config.host });
    console.log(`Demo business API listening on port ${config.port}`);
}
catch (error) {
    console.error(error instanceof Error ? error.message : '启动失败');
    process.exitCode = 1;
}
