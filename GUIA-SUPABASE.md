# Cómo conectar la agenda a la base de datos (Supabase, gratis)

Mientras `config.js` esté vacío, la app funciona en **modo demostración**: los datos quedan
solo en el navegador. Para usarla con un consultorio de verdad seguí estos pasos (unos 10 minutos).

## 1. Crear el proyecto
1. Entrá a **supabase.com** → *Start your project* → ingresá con tu cuenta de GitHub.
2. *New project*:
   - **Name:** el nombre del consultorio (ej. `turnos-alameda`).
   - **Database password:** inventá una y guardala (no hace falta pasármela).
   - **Region:** *South America (São Paulo)*, la más cercana a Argentina.
3. Esperá 1–2 minutos a que se cree.

## 2. Crear las tablas
1. Menú izquierdo → **SQL Editor** → *New query*.
2. Abrí el archivo [`supabase/schema.sql`](supabase/schema.sql), copiá **todo** y pegalo.
3. **Al final del texto**, cambiá `consultorio@ejemplo.com` por el mail con el que va a
   ingresar el consultorio. Podés agregar más de uno.
4. Tocá **Run**. Tiene que decir *Success*.

## 3. Crear el usuario del consultorio
1. Menú → **Authentication** → **Users** → *Add user* → *Create new user*.
2. Poné el **mismo mail** del paso anterior y una contraseña. Marcá *Auto Confirm User*.

## 4. Cerrar el registro público (importante)
**Authentication** → **Sign In / Providers** (o *Settings*) → desactivá
**Allow new users to sign up** y guardá. Así nadie más puede crearse una cuenta.
(Igual, aunque alguien se registrara, no vería nada: solo entran los mails de la tabla `equipo`.)

## 5. Conectar la web
1. **Project Settings** → **API Keys** (o *Data API*). Copiá:
   - **Project URL** (ej. `https://abcdefgh.supabase.co`)
   - **Publishable key** (empieza con `sb_publishable_…`) o, si no aparece, la **anon public**.
2. En GitHub abrí `config.js` → lápiz ✏️ → pegá los dos datos entre las comillas → *Commit changes*.
   (O mandáselos a quien te armó la app.)

> La *Publishable/anon key* es pública: está pensada para ir en la web. **Nunca** uses la
> *Secret key* ni la *service_role*.

## 6. Probar
1. Abrí la web, abajo de todo tocá **Acceso para el consultorio** e ingresá.
2. La primera vez se carga la configuración de ejemplo: editala desde **Configuración**.
3. Reservá un turno desde otro celular: le aparece al consultorio al instante, con la foto de la orden.

## Para tener en cuenta
- **Plan gratis:** 500 MB de base de datos y 1 GB para fotos de órdenes. Alcanza para miles de turnos.
- **Pausa por inactividad:** si el proyecto pasa 7 días sin uso, Supabase lo pausa y hay que
  reactivarlo desde su panel. Un consultorio que lo usa todos los días no llega a pausarse.
- **Agregar otra persona del equipo:** creá el usuario (paso 3) y agregá su mail en
  *Table Editor → equipo → Insert row*.
