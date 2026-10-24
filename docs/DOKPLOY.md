# Desplegar DEAD SMILE LIBRARY en Dokploy

**Repositorio:** `dead-library`  
**URL pública:** `https://library.deadsmile.org`  
**Administración:** `https://library.deadsmile.org/admin`

La configuración preparada utiliza **Docker Compose**, construcción mediante `Dockerfile`, un contenedor no-root y un volumen persistente. No se necesita PostgreSQL, Redis ni almacenamiento S3 para ejecutar la biblioteca.

## 1. Requisitos

- Un servidor Linux con Dokploy instalado y espacio para los archivos de la biblioteca. Como punto de partida, 2 GB de RAM permiten una instalación pequeña; dimensiona disco y memoria según tu catálogo.
- Acceso de administración a Dokploy y SSH al servidor para identificar la red del proxy.
- El repositorio `dead-library` creado en GitHub y el código subido a `main`.
- Control de DNS de `deadsmile.org`.
- Puertos públicos 80 y 443 disponibles para Traefik/HTTPS.

Si aún no tienes Dokploy, sigue la [instalación oficial](https://docs.dokploy.com/docs/core/installation) en un servidor compatible antes de continuar. La guía siguiente parte de un panel ya operativo.

## 2. DNS de `library.deadsmile.org`

En el proveedor DNS crea:

| Tipo | Nombre | Destino |
| --- | --- | --- |
| `A` | `library` | IPv4 pública del servidor de Dokploy |

Añade `AAAA` únicamente si el servidor tiene IPv6 operativo. Si usas Cloudflare, utiliza inicialmente **DNS only / nube gris**, de modo que Let's Encrypt pueda validar el dominio y las subidas lleguen directamente al servidor.

El proxy de Cloudflare puede imponer límites de carga inferiores a 250 MB, según el plan. Para mantener el límite completo de la aplicación, conserva DNS only o utiliza un servicio/plan que permita ese tamaño.

Comprueba la resolución desde tu equipo:

```powershell
Resolve-DnsName library.deadsmile.org
```

## 3. Conectar GitHub con Dokploy

1. Abre **Settings → Git Sources → GitHub** en Dokploy; algunos nombres varían entre versiones.
2. Instala o autoriza la integración de GitHub.
3. Concede acceso al repositorio **`dead-library`**. Para un repo privado, asegúrate de que la integración pueda leerlo.

No necesitas instalar GitHub CLI en el servidor ni poner un token de GitHub dentro del `.env` de la aplicación.

## 4. Crear el proyecto y servicio

1. **Create Project** → nombre **`dead-library`**.
2. Selecciona el entorno de producción del proyecto.
3. **Create Service → Docker Compose**.
4. Source: **GitHub**.
5. Selecciona propietario y repositorio **`dead-library`**.
6. Branch: **`main`**.
7. Compose path: **`./docker-compose.yml`**.
8. Build context: raíz del repositorio.
9. Guarda la configuración.

Selecciona el modo **Docker Compose**, no Docker Stack: este archivo utiliza `build`, que Docker Stack no construye.

Para seguir exactamente esta guía, deja **Isolated Deployments desactivado** y usa la red estándar `dokploy-network`. Si habilitas aislamiento, consulta en **Preview Compose** cuál es la red final y usa su subred en el paso siguiente.

## 5. Identificar la red de Traefik

Por SSH en el servidor de Dokploy ejecuta:

```sh
docker network inspect dokploy-network --format '{{range .IPAM.Config}}{{println .Subnet}}{{end}}'
```

Guarda la subred obtenida: será `TRUST_PROXY`. **No copies una subred de ejemplo**: depende de tu servidor.

Dokploy añade etiquetas de Traefik y la red al servicio cuando configuras su dominio. Si hay varias redes/proxies, confía solo en las direcciones que realmente controlas. `TRUST_PROXY` admite varias subredes separadas por comas.

Si el dominio usa un proxy que no está en la subred configurada, la cookie Secure no se emitirá y el login no podrá conservar la sesión. No lo soluciones con `TRUST_PROXY=true`.

## 6. Generar y cargar variables

Puedes generar una contraseña aleatoria y un secreto de sesión en tu equipo con Node.js:

```powershell
# Contraseña de admin: 48 caracteres hexadecimales.
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"

# Secreto de sesión: 96 caracteres hexadecimales.
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

En el servicio, abre **Environment** y pega el contenido de [`.env.dokploy.example`](../.env.dokploy.example). Completa los campos vacíos:

```dotenv
NODE_ENV=production
PORT=3000
DATA_DIR=/data
PUBLIC_ORIGIN=https://library.deadsmile.org
ADMIN_USERNAME=
ADMIN_PASSWORD=
SESSION_SECRET=
TRUST_PROXY=
```

- `ADMIN_USERNAME`: tu usuario elegido, 3–64 caracteres permitidos.
- `ADMIN_PASSWORD`: tu contraseña propia, mínimo 12 caracteres y máximo 72 bytes. No dejes el campo vacío.
- `SESSION_SECRET`: el secreto generado; mantenlo igual entre despliegues para conservar las sesiones. Si se deja vacío, se genera automáticamente en `/data/.session-secret`.
- `TRUST_PROXY`: la subred real del paso 5.

Guarda las variables. **En Compose, Dokploy las escribe en un `.env`, pero no las inyecta automáticamente**: `docker-compose.yml` ya referencia explícitamente cada variable mediante `${...}` para introducirlas en el contenedor.

Las credenciales se usan solo en ejecución. No se envían como argumentos de construcción ni quedan incorporadas a la imagen. El contenedor guarda el hash bcrypt en SQLite y vuelve a sincronizar la cuenta en cada arranque. Al cambiar las credenciales se invalidan las sesiones anteriores.

Para contraseñas con caracteres especiales, respeta las reglas de comillas/interpolación de los archivos `.env` de Docker Compose. Las cadenas hexadecimales generadas arriba evitan ambigüedades con `$`, comillas y espacios.

## 7. Configurar dominio y certificado

Antes de desplegar, entra en **Domains → Add Domain**:

| Campo | Valor |
| --- | --- |
| Service name | `library` |
| Host | `library.deadsmile.org` |
| Path | `/` |
| Internal Path | Vacío |
| Strip Path | Desactivado |
| Container Port | **`3000`** |
| HTTPS | Activado |
| Certificate | **Let's Encrypt** |

Guarda. No añadas un puerto público en **Advanced → Ports**. El archivo Compose ya usa `expose: 3000`; Traefik accede internamente y sirve al exterior por 443.

El puerto 3000 del contenedor no interfiere con el puerto que pueda utilizar el panel de Dokploy en el host.

En **Preview Compose** comprueba que Dokploy haya añadido las etiquetas del dominio y la red correcta. No es necesario escribir etiquetas de Traefik manualmente.

## 8. Persistencia y despliegue

`docker-compose.yml` define automáticamente:

```yaml
services:
  library:
    volumes:
      - library-data:/data

volumes:
  library-data:
```

No añadas otro montaje encima de `/data`. Dokploy/Docker creará el volumen nombrado; el nombre real normalmente tendrá el prefijo de la aplicación.

Dentro del volumen se guardan SQLite, subidas, portadas y el secreto generado. Un redeploy reemplaza el contenedor, pero mantiene ese volumen.

Pulsa **Deploy** y observa **Deployments / Logs**. El arranque debe mostrar el puerto 3000 y la sincronización del administrador solo cuando haya cambios. No muestra las credenciales.

Después verifica:

1. `https://library.deadsmile.org/healthz` devuelve `{"status":"ok"}`.
2. `https://library.deadsmile.org/` muestra el catálogo.
3. `/admin` abre el acceso y acepta las credenciales configuradas.
4. Sube una obra con dos formatos y una portada.
5. Comprueba los botones dentro del popup.
6. Haz un redeploy y confirma que la obra y sus descargas siguen disponibles.

La imagen incorpora un healthcheck que consulta `127.0.0.1:3000/healthz` cada 30 segundos, sin depender del dominio, de DNS ni del proveedor de geolocalización.

### Una sola instancia

Utiliza **1 réplica**. La biblioteca carga SQLite en memoria y escribe instantáneas atómicas; no está diseñada para varios procesos escritores.

En actualizaciones usa **stop-first** y no habilites despliegues start-first/zero-downtime con el mismo volumen. El lease del directorio impide que una nueva instancia escriba mientras la anterior continúa activa. Tras una interrupción forzada, un lease obsoleto puede tardar unos 30 segundos en recuperarse.

## 9. Llevar tu biblioteca local a Dokploy

Las obras locales no se suben a GitHub ni se incluyen en la imagen. Si quieres trasladarlas:

1. Configura `.env` local con las nuevas credenciales y arranca una vez la versión actual. Las subidas y portadas antiguas registradas en `public/` se mueven al directorio privado.
2. Detén el servidor local y respalda **todo `db/`**, o tu `DATA_DIR` real: `library.db`, `uploads/`, `covers/` y los archivos privados necesarios.
3. Haz un primer despliegue en Dokploy para crear el volumen y luego **detén el servicio `library`**.
4. Identifica el volumen real con la sección de montajes de Dokploy o:

   ```sh
   docker volume ls
   ```

5. Restaura el contenido del respaldo en la **raíz** del volumen, que se monta como `/data`. No lo coloques dentro de un subdirectorio `/data/db`.
6. El contenedor usa UID/GID **1000:1000**. Si el respaldo quedó con otro propietario, con el servicio detenido ajusta solo ese volumen:

   ```sh
   docker run --rm --user 0 -v NOMBRE_REAL_DEL_VOLUMEN:/data node:24-bookworm-slim chown -R 1000:1000 /data
   ```

7. No traslades un lease `.library-lock` ni el antiguo `.data-lock` de una ejecución activa. Inicia nuevamente el servicio; las credenciales se sincronizarán con las variables de Dokploy.

Para mover los datos puedes usar la restauración de volúmenes de Dokploy, SFTP/SSH o un contenedor de copia temporal. El código no debe desplegarse como respaldo de la biblioteca.

## 10. Respaldos

Usa **Volume Backups** de Dokploy:

- Servicio: `library`.
- Volumen: el volumen real correspondiente a `library-data`.
- Destino: tu almacenamiento S3 configurado en Dokploy.
- Frecuencia de ejemplo: diaria, `0 3 * * *`.
- Activa **Turn off Container during backup** para obtener una copia consistente de base y archivos.

Respalda el volumen completo, no solamente `library.db`. Antes de restaurar, detén el servicio y sigue el flujo de restauración de Dokploy. Mantén `SESSION_SECRET` guardado de forma privada si lo suministras por entorno.

## 11. Actualizar código y credenciales

### Código

Publica un commit siguiendo [GITHUB.md](GITHUB.md). En Dokploy pulsa **Deploy** o habilita Auto Deploy para `main` una vez que el despliegue inicial funcione.

El workflow de GitHub prueba y construye la imagen, pero no la publica ni invoca Dokploy. El Auto Deploy del panel es una configuración independiente; no asumas que espera a los checks de GitHub. Usa despliegues manuales si quieres revisar CI antes de cada actualización.

### Credenciales

Edita `ADMIN_USERNAME` y/o `ADMIN_PASSWORD` en **Environment**, guarda y vuelve a desplegar. No borres la base ni ejecutes comandos manuales dentro del contenedor para cambiar contraseñas: la fuente de configuración es el entorno.

## 12. Solución de problemas

| Síntoma | Revisar |
| --- | --- |
| El contenedor no inicia | Logs: credenciales vacías/inválidas, `PUBLIC_ORIGIN` sin HTTPS o permisos de `/data`. |
| `Host no válido` | El dominio solicitado debe coincidir con `PUBLIC_ORIGIN`; Traefik debe conservar el Host. El healthcheck no depende de ese Host. |
| Login vuelve al acceso | Usa HTTPS, comprueba `TRUST_PROXY` y `X-Forwarded-Proto`. Elimina cookies antiguas o prueba una ventana privada después de cambiar dominio/secreto. |
| Error CSRF | Recarga el login/dashboard. Una pestaña con un token anterior puede quedar obsoleta después de cambiar credenciales o cerrar sesión. |
| `La base está en uso` | No ejecutes varias instancias. Detén la anterior y espera unos 30 segundos si terminó de forma abrupta. |
| Permiso denegado en `/data` | Volumen montado en `/data` y propietario 1000:1000. No uses permisos globales de escritura como solución. |
| Datos desaparecen tras redeploy | Verifica el volumen nombrado y que `DATA_DIR=/data`; no uses almacenamiento efímero. |
| Error 413 al subir | Límite de proxy/CDN, especialmente Cloudflare. La app admite 250 MB por archivo, pero la infraestructura puede imponer menos. |
| Error 504 o subida interrumpida | Revisa los tiempos de espera de Traefik/proxy/CDN y el tiempo real que necesita la carga. |
| Certificado no se emite | DNS A/AAAA, puertos 80/443 y logs de Traefik/Let's Encrypt. |
| `No matching manifest` / compilación de Sharp | Usa un servidor Linux amd64 o arm64 compatible con Node 24 y las dependencias opcionales instaladas por `npm ci`. |

## Referencias oficiales

- [Docker Compose en Dokploy](https://docs.dokploy.com/docs/core/docker-compose)
- [Dominios de Compose](https://docs.dokploy.com/docs/core/docker-compose/domains)
- [Dominios y puertos internos](https://docs.dokploy.com/docs/core/domains)
- [Respaldos de volúmenes](https://docs.dokploy.com/docs/core/volume-backups)
