# Importador FFCV — guía de despliegue

Importa jugadores de la web pública de la FFCV (nombre, foto, posición, dorsal,
fecha de nacimiento e historial de clubes). **No guarda DNI ni email.**

## Piezas
- `1_migracion.sql` — tablas y columnas nuevas.
- `2_funcion_importar-ffcv.ts` — Edge Function que hace el trabajo.
- `3_cron.sql` — programador semanal (opcional pero recomendado).
- Botón "Importar FFCV" ya añadido en `admin.html`.

## Pasos (en Supabase)

### 1. Base de datos
Supabase → **SQL Editor** → pega y ejecuta **`1_migracion.sql`**.

### 2. Secretos
Supabase → **Edge Functions → Secrets**. Deben existir (los de R2 ya están de las fotos):
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_PUBLIC_URL`
- **Nuevo:** `FFCV_CRON_SECRET` → inventa una contraseña larga (p.ej. 30 caracteres). Solo la usa el cron.

### 3. Edge Function
Crea una función llamada **`importar-ffcv`** y pega el contenido de
**`2_funcion_importar-ffcv.ts`**. Despliégala.

### 4. Probar a mano (antes del automático)
En la web, entra como admin → pestaña **Importar FFCV**:
1. "Catalogar grupos e iniciar" → llena la cola con los grupos de la temporada actual.
2. "Procesar un lote ahora" → púlsalo varias veces; cada vez avanza unos equipos.
3. "Actualizar estado" → ver cuántos quedan.

Revisa en el visor que van apareciendo jugadores con foto y fecha de nacimiento.

### 5. Automático semanal (cuando la prueba manual vaya bien)
Supabase → **Database → Extensions**: activa `pg_cron` y `pg_net`.
Edita **`3_cron.sql`** sustituyendo `<PROJECT_REF>` y `<FFCV_CRON_SECRET>`, y ejecútalo
en el SQL Editor. A partir de ahí se actualiza solo cada fin de semana.

## Notas
- Ritmo suave: hay una pausa entre llamadas para no saturar a la FFCV.
- Reanudable: si una ejecución se corta, la siguiente sigue donde estaba (tabla `ffcv_cola`).
- Para relanzar todo: pulsa otra vez "Catalogar grupos e iniciar".
