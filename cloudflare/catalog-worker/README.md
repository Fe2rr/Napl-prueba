# NAPL Catalog Worker — Cloudflare D1

El Worker del catálogo utiliza dos bases D1 independientes. El Worker y la base de Ratings permanecen separados y no se modifican.

| Binding del Worker | Base D1 | Contenido |
| --- | --- | --- |
| `DB` | `napl-db` | Juegos, ports, plataformas, desarrolladores, categorías, visitas/popularidad y reportes de enlaces |
| `DEVICES_DB` | `napl-devices-db` | Modelos Android y reportes de compatibilidad |

## 1. Comprobar las bases y aplicar los esquemas

Primero iniciar sesión en Cloudflare si Wrangler todavía no está conectado:

```sh
npx wrangler login
```

Desde esta carpeta, comprobar que las bases no tengan tablas previas:

```sh
npx wrangler d1 execute napl-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
npx wrangler d1 execute napl-devices-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Si ambas están vacías, aplicar los esquemas:

```sh
npx wrangler d1 execute napl-db --remote --file=./schema.sql
npx wrangler d1 execute napl-devices-db --remote --file=./devices-schema.sql
```

Si aparece alguna tabla, detenerse y revisar el esquema existente antes de aplicar cambios. La creación de tablas no importa registros.

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

## 5. Migrar visitas históricas y activar los períodos

Después de desplegar el Worker:

1. Abrir `https://napl-catalog-worker.federicoxastro.workers.dev/admin/import-visits` e importar los totales de la columna `VISITAS` del Sheet. Esto alimenta All Time.
2. Abrir `https://napl-catalog-worker.federicoxastro.workers.dev/admin/import-daily-visits`, ingresar el mismo `IMPORT_SECRET`, seleccionar `NAPL-visitas-ultimos-30-dias.json` e importar.
3. La primera importación diaria fija el punto de inicio de Week. Week cuenta únicamente visitas registradas en D1 desde ese momento; los valores históricos de Apps Script no se usan.
4. Month suma los días del JSON dentro de los últimos 30 días y las visitas nuevas de D1 posteriores al último día importado.
5. All Time suma los totales históricos importados desde Sheets y todos los eventos nuevos de D1. No utiliza `game_visit_totals`, porque esa tabla conserva seeds anteriores y podría duplicar valores.

Ambas importaciones son repetibles: los totales históricos se reemplazan y los registros diarios se actualizan por juego/fecha, sin sumarse otra vez. No ejecutar la importación de visitas hasta desplegar el Worker actualizado.

## 6. Administrar juegos y ports

La interfaz de administración está publicada en `/public/admin.html` (en GitHub Pages: `https://fe2rr.github.io/public/admin.html`).

- Usa el secret existente `IMPORT_SECRET` como contraseña.
- La sesión guarda el secret únicamente en `sessionStorage`; al cerrar la sesión se elimina.
- La API protegida incluye `GET /admin/ports/list`, `POST /admin/ports/save` y `POST /admin/ports/delete`.
- Los cambios se guardan en `napl-db` y actualizan las relaciones normalizadas de desarrolladores y categorías.
- Los identificadores de ports existentes se mantienen fijos durante la edición para no desvincular reportes externos.

Después de actualizar el código del Worker, desplegarlo para habilitar los endpoints de administración.

## 7. Desplegar y verificar

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
