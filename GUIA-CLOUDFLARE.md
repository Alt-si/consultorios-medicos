# Publicar la agenda en Cloudflare (gratis)

Con esto la agenda queda **online de verdad**:
- Vos (administrador) creás una **cuenta para cada consultorio** y le pasás mail + contraseña.
- Cada consultorio entra desde cualquier celular o computadora y tiene **sus propios datos**.
- Cada consultorio tiene **su link para pacientes** (ej. `…pages.dev/?c=consultorio-dra-lopez`). Los pacientes reservan sin registrarse.

La versión de GitHub Pages sigue funcionando como **demostración** (usuario `demo@consultorio.com`, clave `demo1234`).

---

## 1. Crear la cuenta de Cloudflare
Entrá a **dash.cloudflare.com** → *Sign up*. Es gratis y no pide tarjeta.

## 2. Crear la base de datos
1. Menú izquierdo → **Storage & Databases** → **D1 SQL Database**.
2. **Create** → nombre: `turnos-db` → **Create**.
   (Las tablas se crean solas; no hay que escribir nada.)

## 3. Publicar la web desde GitHub
1. Menú izquierdo → **Workers & Pages** → **Create** → pestaña **Pages** →
   **Import an existing Git repository** (o *Connect to Git*).
2. Conectá tu cuenta de GitHub y elegí **Alt-si/consultorios-medicos** → **Begin setup**.
3. Completá:
   - **Project name:** `consultorios-medicos` (va a quedar `consultorios-medicos.pages.dev`)
   - **Framework preset:** *None*
   - **Build command:** dejalo **vacío**
   - **Build output directory:** `/`
4. **Save and Deploy**. Esperá a que termine (1 minuto).

## 4. Conectar la base de datos y el código de instalación
En el proyecto `consultorios-medicos` → **Settings**:
1. **Bindings** → **Add** → **D1 database**
   - **Variable name:** `DB` (en mayúsculas, exactamente así)
   - **D1 database:** `turnos-db` → **Save**
2. **Variables and Secrets** → **Add**
   - **Type:** *Secret* · **Variable name:** `SETUP_CODE`
   - **Value:** inventá un código (ej. `MiCodigo2026`) y guardalo → **Save**
3. Andá a **Deployments** → en el último, tocá los **⋯** → **Retry deployment**
   (para que tome la base de datos y el código).

## 5. Crear tu cuenta de administrador
1. Abrí **https://consultorios-medicos.pages.dev**
2. Aparece **"Primera vez: creá tu cuenta de administrador"**: poné el `SETUP_CODE`,
   tu nombre, tu mail y una contraseña.
3. Quedás en **Cuentas**.

## 6. Crear la cuenta de un profesional
1. En **Cuentas** → nombre del consultorio + mail del profesional → **Crear cuenta**.
2. Se muestra la **contraseña una sola vez**: tocá **Enviar por WhatsApp** o **Copiar datos**.
3. El profesional entra en `consultorios-medicos.pages.dev` → **Ingresar**, y desde
   **Configuración** carga sus profesionales, horarios, estudios y logo, y copia su link para pacientes.

Desde **Cuentas** también podés darle una **contraseña nueva** o **desactivar** la cuenta
(deja de poder ingresar y su link de turnos deja de funcionar).

---

### Para tener en cuenta
- **Cada cambio que subamos a GitHub se publica solo** en Cloudflare en 1–2 minutos.
- **Plan gratis:** 5 GB de base de datos y 100.000 pedidos por día: alcanza para muchos consultorios.
  No se pausa por inactividad.
- Las **fotos de órdenes médicas** quedan guardadas en la base, privadas: solo las ve el consultorio.
- Los turnos nuevos le aparecen al consultorio en el panel en menos de 20 segundos, con un aviso.
