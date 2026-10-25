# Auditoría técnica local de privacidad

Fecha de revisión: **25 de octubre de 2026**. Este informe describe exclusivamente la copia local del proyecto. No certifica el estado de la instalación de Dokploy ni emite una conclusión jurídica.

## Alcance y método

- Revisión de código de servidor, interfaz, rutas, persistencia, sesiones y configuración de recursos.
- Inspección de solo lectura del esquema y contadores de la base local; no se imprimieron IPs, nombres de usuario, contraseñas ni valores de registros.
- Comprobación de patrones conocidos de analítica y proveedores externos, complementada con pruebas de navegador y migración.
- Sin reescribir historial de Git, sobrescribir respaldos, modificar logs ni ejecutar la migración sobre la base real durante la auditoría.

## Resultado del código actual

- Sin módulo de registro de visitas, geolocalización, ISP o User-Agent.
- Sin beacons de seguimiento, recibos de visita ni identificadores persistentes de visitantes.
- Fuentes, scripts, estilos e imágenes de la interfaz servidos desde el propio sitio.
- Preferencias `ds_theme` y `ds_ink` limitadas a apariencia; solo se escriben después de una elección, no para almacenar los valores predeterminados en una primera visita.
- Cookie y sesiones del administrador utilizadas para autenticación. No se convierten en un historial público de visitas.
- Límites de solicitudes basados en IP en memoria, con ventanas temporales, sin escribir la IP en SQLite.

La búsqueda de patrones conocidos no demuestra por sí sola la ausencia de cualquier tratamiento de datos. Los resultados se apoyan también en la revisión del flujo de ejecución y las pruebas.

### Comprobaciones ejecutadas

- `npm test`: **23 pruebas aprobadas**, incluyendo ausencia de analítica, migraciones y auditoría sin modificaciones.
- `npm run test:responsive`: **62 pruebas aprobadas** en Chromium y WebKit; se verifica que la interfaz no solicite recursos de otros orígenes y que una primera visita no cree cookies ni preferencias locales predeterminadas.
- `npm audit`: **0 vulnerabilidades reportadas** en las dependencias instaladas al revisar esta copia.
- `npm run audit:privacy` sobre la base real local: salida **2**, por los registros/esquema históricos descritos a continuación. Esto es un hallazgo pendiente, no un resultado «limpio» de la base.

## Hallazgo en el archivo local existente

La comprobación `npm run audit:privacy` encontró en `db/library.db`:

- **13 filas** en la tabla antigua `visits`.
- La columna antigua `uploader_ip` en `works`.
- **2 archivos de respaldo anteriores**, cuyo contenido no se inspeccionó.

Por tanto, el código ya no recopila esa analítica, pero **el archivo local inspeccionado todavía requiere la migración de retirada**. No debe describirse ese archivo como libre de datos históricos antes de aplicar y verificar dicha migración.

La migración existente se conserva para retirar las tablas/campos antiguos y compactar la base activa cuando corresponda actualizarla. Las pruebas de esa migración usan copias sintéticas aisladas, nunca la biblioteca real. Las referencias de compatibilidad y pruebas no son seguimiento activo y no se eliminan para aparentar que versiones anteriores nunca existieron.

## Datos que sí forman parte de la aplicación

| Datos | Uso |
| --- | --- |
| Usuario administrador y hash bcrypt | Autenticación |
| Sesiones, expiración y tokens CSRF | Control de acceso y protección de escrituras |
| Tema y color locales | Preferencias solicitadas por el visitante |
| Títulos, autoría, descripciones y nombres de archivos | Publicación del catálogo por el administrador |
| Contenido de los archivos | Distribución de las obras subidas |
| IP temporal en memoria | Límites de solicitudes y protección frente a intentos abusivos |

El contenido de PDFs, EPUBs y otros archivos no fue auditado para determinar si incluye información personal de terceros. No debe afirmarse que la aplicación no trata ningún dato personal: cuenta, sesiones y contenido pueden contener datos, aunque no exista analítica de visitas.

## Límites y aspectos del responsable

- No se inspeccionaron backups anteriores, snapshots, logs del hosting/proxy/CDN ni datos que hubieran recibido terceros.
- Su conservación o eliminación debe decidirse según finalidad, plazos y obligaciones aplicables; esta auditoría no los altera.
- El historial de versiones conserva su función de trazabilidad.
- Identidad/contacto del responsable, información pública de privacidad, bases jurídicas y requisitos territoriales requieren datos del operador y revisión jurídica. No se han inventado ni certificado.
- Reducir la recopilación no convierte automáticamente un sitio en «100 % legal» ni modifica lo que haya ocurrido anteriormente.

## Repetir la inspección sin modificar los datos

```powershell
npm.cmd run audit:privacy
```

Para un directorio privado específico:

```powershell
npm.cmd run audit:privacy -- --data-dir "ruta\al\directorio-privado"
```

El comando no inicia el servidor, no aplica migraciones, no crea una cuenta, no genera secretos y no exporta registros personales. Devuelve metadatos de esquema y cantidades:

- Salida `0`: sin patrones conocidos ni esquema antiguo detectados en la inspección.
- Salida `1`: patrón que requiere revisión o error de lectura.
- Salida `2`: base existente con esquema/datos históricos que requieren migración.

Una salida `0` no es una certificación legal ni una garantía de que nunca haya existido seguimiento.
