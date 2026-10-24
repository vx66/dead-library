# Publicar `dead-library` en GitHub

Estos comandos son para ejecutarlos manualmente. Preparar el proyecto no crea repositorios, commits ni publicaciones remotas.

## 1. Preparar el repositorio vacío

En GitHub, abre **New repository** y configura:

- Nombre: **`dead-library`**.
- Visibilidad: **Private** para empezar.
- No añadas README, `.gitignore` ni licencia desde la web: el proyecto ya contiene los archivos necesarios.

El repositorio contendrá el código. Tu `.env`, biblioteca, archivos personales, logs, base de datos y respaldos quedan fuera mediante `.gitignore` y `.dockerignore`.

## 2. Revisar localmente

Abre PowerShell en la carpeta del proyecto. Sustituye la ruta del ejemplo por la ubicación de tu copia:

```powershell
Set-Location "ruta\a\dead-smile-library"
npm.cmd ci
npm.cmd test
```

Si trabajas en otra ubicación, usa la ruta de tu copia. La carpeta puede seguir llamándose `dead-smile-library`; el repositorio remoto y el paquete se llaman `dead-library`.

## 3. Inicializar, preparar y revisar

Para una carpeta que todavía no tiene Git:

```powershell
git init -b main
git add .
npm.cmd run check:repo
git status --short
git diff --cached --stat
git diff --cached
```

`check:repo` revisa los nombres de todos los archivos incluidos en el índice y falla si detecta rutas de datos o secretos. La revisión de `git diff --cached` permite comprobar el contenido antes del commit.

Las dos plantillas `.env.example` y `.env.dokploy.example` deben tener las credenciales vacías. No incluyas un `.env` real ni una copia del directorio privado.

Si encuentras un archivo que no corresponde, retíralo del índice, sin borrarlo de tu disco:

```powershell
git restore --staged -- "ruta/al/archivo"
```

## 4. Commit y primera subida

Sustituye **`TU_USUARIO`** por tu usuario u organización de GitHub:

```powershell
git commit -m "Prepare dead-library for Dokploy"
git remote add origin https://github.com/TU_USUARIO/dead-library.git
git push -u origin main
```

La autenticación HTTPS se realiza mediante Git Credential Manager o un token de GitHub. No uses tu contraseña normal como token ni lo insertes en la URL remota.

## 5. Comprobar GitHub

- Abre el repositorio y revisa la portada del README.
- En **Actions**, espera a que termine **Test & Docker**.
- El workflow no necesita tus credenciales reales ni secretos de Dokploy: utiliza fixtures efímeras y no publica nada.
- En **Settings → Branches / Rulesets**, puedes exigir que `main` tenga las comprobaciones de CI aprobadas antes de integrar cambios.

## 6. Cambios posteriores

```powershell
git status --short
git add .
npm.cmd run check:repo
git diff --cached
git commit -m "Describe the update"
git push
```

Después de una subida, Dokploy puede desplegar manualmente o mediante Auto Deploy según lo que configures allí. [Continuar con Dokploy →](DOKPLOY.md)
