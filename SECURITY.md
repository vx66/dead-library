# Revisión de seguridad

## Problemas corregidos

| Área | Corrección |
| --- | --- |
| Credenciales en el código | `ADMIN_USERNAME` y `ADMIN_PASSWORD` son obligatorias en el entorno. No hay cuenta predeterminada. El arranque sincroniza una única cuenta, guarda únicamente el hash bcrypt e invalida sesiones si las credenciales cambian. |
| Secreto de sesión predecible | Secreto aleatorio por instalación, persistido en un archivo privado o proporcionado mediante configuración. |
| Fijación y caducidad de sesiones | Identificador regenerado al iniciar sesión, cookie HttpOnly/SameSite=Strict, Secure con HTTPS en producción, 8 horas de inactividad y 24 horas de duración absoluta. |
| Almacenamiento de sesiones | Sesiones persistentes en SQLite con identificadores SHA-256, expiración e invalidación al cerrar sesión o cambiar el administrador. |
| CSRF | Token asociado a la sesión y comprobación de origen en inicio de sesión y todas las operaciones de escritura del admin. Salir requiere POST. |
| Fuerza bruta | Máximo de 5 intentos fallidos por IP en 15 minutos. Los encabezados de reenvío no se aceptan sin proxies configurados explícitamente. |
| Acceso sin sesión | Endpoints administrativos y estadísticas protegidos; los endpoints de datos devuelven 401, sin entregar vistas de acceso como si fueran JSON. |
| XSS | Datos escapados en catálogo, formularios y estadísticas. Scripts externos propios, sin manejadores inline. CSP impide scripts inline, objetos incrustados y uso del sitio dentro de marcos. |
| Recursos externos de JavaScript | Chart.js servido localmente desde una dependencia versionada, en lugar de un CDN sin versión fija. |
| Subidas | Multer actualizado; campos, cantidades, tamaños, tipos de metadatos y nombres validados. Los archivos no se ejecutan y quedan fuera del directorio público. |
| Portadas | Decodificación real y conversión a WebP con límites de tamaño/píxeles. Se rechazan HTML, SVG y archivos inválidos presentados como imágenes. |
| Descargas | Tokens criptográficos de 256 bits, nombres internos aleatorios, Content-Disposition attachment, Content-Type application/octet-stream, nosniff y sandbox. Sin ruta pública por ID numérico o acceso directo a uploads. |
| Datos y errores | Sin contraseñas, hashes, nombres internos de archivos o IP de quien subió en la API pública. Errores sin rutas locales, consultas ni stack traces. |
| Persistencia | Escritura atómica, restauración de memoria ante fallo de transacción y lease de sistema de archivos para evitar escritores concurrentes, incluso entre contenedores con PIDs reciclados. |
| Contenedor | Imagen multietapa sin `.env` ni datos personales, ejecución como usuario `node`, datos en `/data` y healthcheck local. Compose configura sistema de archivos de solo lectura, capacidades eliminadas y sin puerto público en producción. |
| Tráfico y geolocalización | Estadísticas privadas por solicitud, clasificación orientativa y señal JavaScript firmada. Geolocalización HTTPS con IP validada, caché acotada y concurrencia limitada. Escritura por lotes, cola de 1000 eventos con descartes visibles, retención de 90 días y máximo de 50 000 registros. |

## Encapsulación

- `lib/config.js`: configuración y secreto privado.
- `lib/admin.js`: validación y sincronización de credenciales del entorno.
- `lib/database.js`: consultas parametrizadas, transacciones y migraciones.
- `lib/security.js`: sesiones, cookies, CSRF, cabeceras y límites de solicitudes.
- `lib/storage.js`: subidas, portadas, rutas privadas y limpieza.
- `lib/validation.js`: validación de entradas.
- `lib/visits.js`: geolocalización y registro acotado de visitas.
- `lib/traffic-classifier.js`: reglas orientativas de clasificación, tipo de petición y anonimización de rutas.
- `lib/countries.js`: códigos de países, incluyendo nombres de registros históricos.
- `lib/data-lock.js`: exclusión entre instancias y herramienta de administración.

## Alcance

Esta biblioteca mantiene un catálogo y descargas públicos: quien visita el sitio puede obtener sus enlaces desde el catálogo. Los tokens evitan enumerar IDs internos; no cifran el contenido ni convierten una descarga pública en privada.

La CSP conserva estilos inline por el diseño actual; el permiso de estilos no habilita JavaScript inline. IBM Plex Mono puede cargarse desde Google Fonts; no se carga JavaScript de terceros en el navegador.

Las coordenadas de una IP son aproximadas y no acreditan una ubicación física. Los límites de acceso y sesiones se han diseñado para una sola instancia de Node; el bloqueo impide que dos instancias usen simultáneamente la misma base.

Los User-Agent y patrones de tráfico son señales falsificables: clasificar como navegador o recibir JavaScript no demuestra una visita humana. Los recibos de señal JS están firmados, caducan a los cinco minutos y se vinculan a una página/IP/User-Agent, sin añadir un identificador persistente de visitante. No se guardan cuerpos, cookies, credenciales ni parámetros de consulta en el registro; los tokens de descarga se ocultan en las rutas. Consulta [TRAFFIC.md](docs/TRAFFIC.md).

Las variables de administrador y `SESSION_SECRET` se configuran en `.env` local o en Environment de Dokploy. No deben incluirse en Git ni como argumentos de construcción de Docker. El servidor no cambia estas variables: un cambio de contraseña debe hacerse en el entorno y aplicarse mediante reinicio/redeploy.

En Dokploy configura `TRUST_PROXY` con la IP/subred real de Traefik y no publiques el puerto de Node al exterior. Conserva el volumen `/data`, utiliza una réplica y actualizaciones stop-first. El healthcheck `/healthz` devuelve únicamente disponibilidad y no exige el Host público ni autenticación.

La revisión abarca el código de esta aplicación, dependencias declaradas y pruebas locales. La configuración efectiva de HTTPS, proxy, permisos del sistema, exposición de puertos y copias de respaldo corresponde al entorno donde se publique.

## Resultado de las comprobaciones

- Suite automatizada de integración, seguridad y configuración de despliegue disponible mediante `npm test`.
- Flujo de navegador comprobado con CSP activa: acceso, subida y edición multiformato, portadas, confirmaciones de categorías, gráficas locales, popup público, descarga y cierre de sesión.
- Se usó contenido con etiquetas y manejadores de eventos como prueba de XSS: se mostró como texto, sin ejecución.
- `npm audit --omit=dev`: 0 vulnerabilidades reportadas al realizar la revisión. Repetir el comando al actualizar dependencias.
- La imagen debe construirse y probarse con Docker. El workflow `Test & Docker` lo hace en GitHub Actions sin publicar imágenes ni desplegar servicios.
