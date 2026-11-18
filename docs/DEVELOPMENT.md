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

Тесты загрузок, браузера, записи и трея: `tests/`. `pnpm dist` создаёт в `dist/` установщик `PULL-Setup-*.exe`, `*.blockmap` и `latest.yml`.

## Выпуск версии

1. Поднимите `version` в `package.json` и запишите изменения в `CHANGELOG.md`.
2. `pnpm test`, затем `pnpm dist`.
3. Создайте релиз `vX.Y.Z` на GitHub и приложите `PULL-Setup-X.Y.Z.exe`, `PULL-Setup-X.Y.Z.exe.blockmap`, `latest.yml` и копию `latest.yml` под именем `beta.yml` (её читают установленные бета-версии).
4. Установленные копии PULL найдут релиз в течение 6 часов или сразу по кнопке «Проверить» в настройках.

Для проверки обновления без GitHub установленную версию можно запустить с переменной `PULL_UPDATE_URL`, указывающей на папку с `latest.yml` и установщиком, раздаваемую по HTTP. [Компоненты и лицензии](../THIRD-PARTY-NOTICES.md), [проверки поставки](../VALIDATION.md).
