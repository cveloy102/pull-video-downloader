# Сборка PULL

Требуются Windows x64, Node.js и pnpm.

```powershell
pnpm install
node scripts/setup-tools.cjs
pnpm icons     # пересобрать иконки, если менялся скрипт
pnpm test
pnpm start
pnpm dist
```

Скрипт подготовки скачивает yt-dlp и FFmpeg с проверкой SHA256. Для сборки нужен доступ к официальным GitHub Releases и реестру npm.

Приложение построено на Electron. Внешние страницы работают в изолированном Chromium без Node.js. Расширение подключается к локальному серверу с индивидуальным токеном; код находится в `extension/`.

Тесты загрузок, браузера, записи и трея: `tests/`. `pnpm dist` создаёт в `dist/` установщик `PULL-Setup-*.exe` и портативную версию. [Компоненты и лицензии](../THIRD-PARTY-NOTICES.md), [проверки поставки](../VALIDATION.md).
