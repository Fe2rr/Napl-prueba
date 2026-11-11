# NAPL Catalog Worker — Cloudflare D1

El Worker del catálogo utiliza dos bases D1 independientes. El Worker y la base de Ratings permanecen separados y no se modifican.

| Binding del Worker | Base D1 | Contenido |
| --- | --- | --- |
| `DB` | `napl-db` | Juegos, ports, plataformas, desarrolladores, categorías, visitas/popularidad y reportes de enlaces |
| `DEVICES_DB` | `napl-devices-db` | Modelos Android y reportes de compatibilidad |

## 1. Aplicar los esquemas

Ejecutar desde esta carpeta:

```sh
npx wrangler d1 execute napl-db --remote --file=./schema.sql
npx wrangler d1 execute napl-devices-db --remote --file=./devices-schema.sql
```

Esto crea las tablas, pero no importa registros.

## 2. Importar el catálogo desde el CSV

Usar el CSV exportado de Google Sheets. Pasar la ruta del archivo local:

```sh
node scripts/migrate-from-sheet.mjs ./Community-Ports.csv
npx wrangler d1 execute napl-db --remote --file=./seed.sql
```

El SQL generado utiliza operaciones upsert y no ejecuta eliminaciones masivas. Si se vuelve a ejecutar, actualiza los registros coincidentes en lugar de vaciar la base. D1 gestiona las transacciones automáticamente, por lo que los archivos no incluyen instrucciones manuales `BEGIN` ni `COMMIT`.

Los valores originales se conservan en `games.genre` y `ports.developer`. También se rellenan las tablas normalizadas `categories`, `game_categories`, `developers` y `port_developers`.

## 3. Importar los dispositivos Android

Los archivos anteriores `public/assets/data/devices.json` y `devices-seed.sql` estaban vacíos. Se necesita un JSON válido con un array de objetos que tengan `id` y `name`. Con ese archivo:

```sh
node scripts/migrate-devices.mjs ./devices.json
npx wrangler d1 execute napl-devices-db --remote --file=./devices-seed.sql
```

El importador rechaza archivos vacíos o con formato incorrecto.

## 4. Migrar la popularidad histórica

Antes de retirar el endpoint de Apps Script:

```sh
node scripts/migrate-popularity.mjs
npx wrangler d1 execute napl-db --remote --file=./popularity-seed.sql
```

Este proceso importa los totales históricos. No reconstruye el historial de visitas diarias.

## 5. Desplegar y verificar

Después de aplicar los esquemas e importar los datos necesarios:

```sh
npx wrangler deploy
```

Verificar en la URL del Worker:

- `GET /health`: conteos de ambas bases.
- `GET /catalog`: catálogo.
- `GET /devices`: modelos de dispositivos.
- `GET /popular?period=alltime`: popularidad histórica.
- `GET /compatibility?port_ids=...`: reportes de compatibilidad.

Cuando el Worker esté desplegado y probado, colocar su URL en `CATALOG_API_BASE` dentro de `public/js/core/config.js`. Hasta entonces, el frontend mantiene el fallback actual a Sheets.

## Precauciones

- No borrar ni desactivar Google Sheets o Apps Script hasta validar catálogo, dispositivos, popularidad y frontend.
- No modificar el Worker ni la D1 de Ratings durante esta migración.
- No ejecutar importaciones en producción antes de comprobar el CSV y el origen de los dispositivos.
