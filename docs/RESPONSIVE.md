# Móviles y tablets

La interfaz se comprueba con Playwright en **Chromium y WebKit**, con tamaños de viewport y entrada táctil emulados. Las comprobaciones usan una biblioteca temporal con títulos, categorías, nombres de archivo y descripciones largos; no modifican la biblioteca real.

## Adaptaciones

- Catálogo en dos columnas en móviles y grilla adaptable en pantallas mayores, con portadas en proporción 2:3.
- Filtros apilados en teléfonos estrechos y controles principales de al menos 44 px de alto.
- Texto de entradas de al menos 16 px para evitar el zoom automático al enfocar campos en iOS.
- Encabezado rotativo con espacio reservado para todas las frases. La altura permanece estable durante escritura y borrado; los caracteres compuestos no se cortan.
- Navegación del dashboard visible en tablets y móviles, con indicación de pestaña actual.
- Tablas de descargas presentadas como fichas etiquetadas en pantallas pequeñas. En tablets, las tablas anchas permiten desplazamiento dentro de su propia región.
- Popups con encabezado y cierre accesibles, desplazamiento interno y ajuste al área disponible mediante Visual Viewport.
- Bloqueo del fondo al abrir un popup y recuperación de la posición y foco al cerrarlo.
- Soporte de áreas seguras, tema oscuro/claro y preferencia de movimiento reducido.
- Selector compacto de blanco y seis colores neón: cuadrados visibles de 16×16 px dentro de botones de 24×24 px, con selección directa y estado accesible. La paleta se ajusta al espacio disponible junto al tema. El catálogo negro mantiene contraste para los tonos neón.

## Matriz de tamaños

| Perfil | Viewports comprobados |
| --- | --- |
| Teléfonos verticales | 320×568, 360×800, 375×667, 390×844, 414×896 |
| Teléfonos horizontales | 667×375, 844×390 |
| Tablets | 600×960, 768×1024, 820×1180, 1024×768, 1180×820 |
| Referencia de escritorio | 1280×800 |

Además se comprueban ampliación de texto al 200 %, movimiento reducido, cambio de orientación y una altura disponible de 340 px para los formularios en popup. La reducción de altura simula un área visible menor; no se utiliza un teclado ni un dispositivo físico.

## Ejecutar las pruebas

Desde PowerShell, después de instalar dependencias:

```powershell
npx.cmd playwright install chromium webkit
npm.cmd run test:responsive
```

En Linux, para instalar también las bibliotecas que necesitan los navegadores:

```sh
npx playwright install --with-deps chromium webkit
npm run test:responsive
```

La suite comprueba catálogo, filtros, descargas, login, subida, edición, categorías y confirmaciones. También verifica ausencia de desbordamiento horizontal del documento, tamaño de controles y ajuste de los modales, además de los siete colores, su persistencia, la selección explícita de blanco y el funcionamiento si el almacenamiento local está bloqueado. Comprueba que la interfaz no haga solicitudes a servicios externos.

Los resultados y las trazas de fallos se generan en `test-results/`, excluido de Git. GitHub Actions ejecuta esta suite antes de la comprobación Docker.
