# Tráfico y visitas

El panel `/admin` → **Tráfico y visitas** separa solicitudes HTTP, páginas de inicio y señales de navegador. Los datos son orientativos: ni una IP ni un User-Agent identifican de forma fiable a una persona.

## Clasificación

| Etiqueta | Evidencia utilizada |
| --- | --- |
| Navegador probable | User-Agent de navegador junto con cabeceras compatibles con navegación, recursos o una señal JavaScript válida. |
| Bot declarado | El User-Agent declara un rastreador o bot conocido. No se verifica la identidad del proveedor mediante DNS/IP. |
| Automatizado probable | Herramientas HTTP, monitores o navegadores automatizados declarados: curl, Python, HeadlessChrome, etc. |
| Sospechoso | Rutas de exploración como `.env`, `.git` o WordPress; herramientas de escaneo; respuestas 429; o patrones de alta frecuencia/fallos repetidos. |
| Sin clasificar | Faltan señales suficientes, no hay User-Agent o se trata de un registro histórico sin cabeceras. |

La prioridad es actividad sospechosa → bot declarado → automatización → navegador → sin clasificar. Ejecutar JavaScript no transforma un bot declarado o navegador headless en una visita humana. Un proveedor de hosting como AWS u OVH no determina por sí mismo la categoría.

Los umbrales de actividad son 120 solicitudes, 15 respuestas 404 o 5 intentos de acceso fallidos desde la misma IP en una ventana de un minuto. Son indicadores, no pruebas de ataque. Esta clasificación no añade bloqueos por país ni por proveedor; siguen vigentes los límites de seguridad de autenticación y API.

## Señal JavaScript

La portada incluye un recibo firmado HMAC, de cinco minutos de duración, vinculado a esa solicitud, IP y User-Agent. El script propio envía el recibo a `/api/traffic/confirm`, sin cookies adicionales de analítica ni identificador persistente de visitante.

La señal se contabiliza una sola vez. Confirma que se envió una señal vinculada a la página, no que había una persona: un bot también puede procesar páginas y ejecutar JavaScript.

## Qué cuentan los indicadores

- **Solicitudes registradas:** peticiones HTTP guardadas que llegaron a Node; incluyen recursos y API. No incluyen solicitudes rechazadas antes por Traefik/CDN ni garantizan representar todo el tráfico de red.
- **Páginas de inicio:** respuestas completas GET 200 de `/`, además de los registros históricos de portada conservados.
- **Páginas de navegador probable:** páginas de inicio clasificadas como navegador.
- **Páginas con señal JavaScript:** páginas que devolvieron un recibo válido. Incluye automatizaciones capaces de ejecutar JS.
- **Bots + automatización:** solicitudes clasificadas en esas dos categorías, no personas.
- **IPs distintas:** direcciones diferentes en los registros filtrados. Una persona puede usar varias IPs y varias personas pueden compartir una.
- **Solicitudes de descarga:** respuestas GET 200/206 de descarga. Varias peticiones de rango pueden corresponder al mismo archivo; no acreditan una descarga completa ni lectura.
- **Bytes de respuesta medidos:** suma de Content-Length cuando está disponible. No representa ancho de banda total; HEAD, 204 y 304 cuentan cero y las respuestas interrumpidas no se estiman.

Las respuestas interrumpidas se muestran con estado interno 499. No implican por sí mismas actividad sospechosa.

## Tabla, filtros y gráficas

Se conservan **IP, país, ciudad, región, ISP y fecha**. El país se representa con una bandera emoji y el nombre queda disponible al pasar el cursor o mediante accesibilidad. 🌐 representa ubicación desconocida/no disponible. El aspecto final del emoji depende de las fuentes del sistema.

La tabla añade clasificación y motivo, método, ruta, estado HTTP, duración, bytes, User-Agent, señal JS y origen de referencia. Los colores de riesgo se aplican a la clasificación: una IP pública no se pinta como peligrosa solo por ser pública.

Puedes filtrar por hoy/7/30/90 días, clasificación, tipo de petición e IP exacta. La tabla tiene páginas de 50 registros y actualización cada 30 segundos mientras está visible, que se puede desactivar. Los contadores y las tres gráficas respetan los filtros.

Las ventanas y gráficas diarias usan UTC; las fechas de la tabla se convierten a la zona horaria del navegador.

## Privacidad y rendimiento

- No se guardan contraseñas, cuerpos de solicitud, cookies, encabezados Authorization ni parámetros de consulta.
- Las rutas de descarga ocultan el token y las rutas de administración normalizan los IDs. Las referencias omiten usuario/contraseña, parámetros y fragmentos.
- Se excluyen `/healthz`, la confirmación de JavaScript, la obtención de CSRF y las consultas autenticadas normales del panel, para evitar contar el propio monitor.
- La geolocalización usa HTTPS, caché acotada y un máximo de cuatro consultas concurrentes; puede fallar o representar un proxy/centro de datos.
- El registro se escribe por lotes y tiene una cola máxima de 1000 solicitudes. Si se satura, el panel informa cuántos eventos se omitieron desde el último reinicio.
- Se conservan como máximo 50 000 filas durante 90 días. Las métricas se calculan sobre esos registros retenidos.

## Actualizar una biblioteca existente

La migración añade las columnas necesarias y crea una copia privada de la base antes de actualizar un esquema antiguo. No borres `library.db` ni el volumen de Dokploy.

Las IPs anteriores se conservan, pero los registros antiguos no tenían User-Agent, estado ni frecuencia completa: se muestran como **Sin clasificar / histórico**. No se inventa una clasificación retroactiva. Cuando el país antiguo se reconoce, se obtiene su bandera a partir del nombre guardado.

No se necesitan nuevas variables de entorno. Publica el código actualizado y haz **Deploy** en Dokploy conservando el volumen `/data` y una sola instancia escritora.
