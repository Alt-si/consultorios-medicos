# WhatsApp automático para cada consultorio

Cuando está activo, al paciente le llega **solo**:
1. **Al reservar** (desde la web o cuando el consultorio le agenda un turno): turno, día y hora,
   profesional o estudio, dirección, **preparación del estudio**, qué tiene que traer y
   **monto a abonar según su obra social**.
2. **El día anterior** (a la hora que elija el consultorio): el recordatorio con los botones
   **Confirmo** y **Necesito cambiarlo**. Lo que toque el paciente se ve solo en el panel.

Las respuestas escritas de los pacientes aparecen en el **Panel → Mensajes de WhatsApp** y se pueden contestar desde ahí.

## Qué hace falta
- **Un número exclusivo** (chip nuevo o línea fija que pueda recibir un SMS o una llamada).
  Ese número **deja de usarse en la app de WhatsApp**: se maneja desde la agenda.
- Una cuenta de **Facebook** del responsable del consultorio.
- Una **tarjeta** cargada en Meta: cada mensaje que manda el consultorio cuesta alrededor de
  US$ 0,03 (2 mensajes por turno). Lo que responde el paciente no se cobra.

Cada consultorio hace estos pasos con **su** cuenta y **su** número (unos 30 minutos).

---

## 1. Crear la app de WhatsApp en Meta
1. Entrá a **developers.facebook.com** → *Mis apps* → **Crear app**.
2. Caso de uso: **Conectarte con clientes a través de WhatsApp** → *Siguiente*.
3. Si te lo pide, creá o elegí un **portafolio comercial** (el nombre del consultorio).
4. Terminá de crear la app.

## 2. Agregar el número
1. En la app → **WhatsApp** → **Configuración de la API**.
2. **Agregar número de teléfono** → nombre visible (el del consultorio) → categoría *Salud* →
   número → verificalo con el código que llega.
3. Copiá el **Identificador del número de teléfono** (*Phone number ID*). Va en la agenda.

## 3. Token permanente
1. Entrá a **business.facebook.com** → ⚙ **Configuración del negocio** → *Usuarios* → **Usuarios del sistema**.
2. **Agregar** → nombre `agenda` → rol **Administrador**.
3. **Asignar activos**: la **app** (control total) y la **cuenta de WhatsApp** (control total).
4. **Generar token** → elegí la app → caducidad **Nunca** → permisos
   `whatsapp_business_messaging` y `whatsapp_business_management` → **Generar**.
5. Copiá el token (se ve una sola vez). Va en la agenda.

## 4. Clave secreta de la app
En **developers.facebook.com** → tu app → **Configuración de la app** → **Básica** →
**Clave secreta de la app** → *Mostrar* → copiala. Va en la agenda (sirve para recibir las respuestas de forma segura).

## 5. Forma de pago
En **WhatsApp Manager** (business.facebook.com/wa/manage) → **Configuración de pagos** → agregá la tarjeta.

## 6. Crear las dos plantillas de mensaje
**WhatsApp Manager** → **Plantillas de mensajes** → **Crear plantilla**.

### Plantilla 1
- **Categoría:** Utilidad · **Nombre:** `turno_confirmacion` · **Idioma:** Español (ARG)
- **Cuerpo** (copiá tal cual):
```
Hola {{1}}, tu turno en {{2}} quedó registrado.

📅 {{3}}
🩺 {{4}}
📍 {{5}}
💳 {{6}}

Indicaciones: {{7}}

Si no podés venir, avisanos respondiendo este mensaje.
```

### Plantilla 2
- **Categoría:** Utilidad · **Nombre:** `turno_recordatorio` · **Idioma:** Español (ARG)
- **Cuerpo:**
```
Hola {{1}}, te recordamos tu turno de mañana en {{2}}.

📅 {{3}}
🩺 {{4}}
📍 {{5}}
💳 {{6}}

Indicaciones: {{7}}

Por favor, confirmá tu asistencia con los botones de abajo.
```
- **Botones** → *Respuesta rápida* → agregá dos, **en este orden**: `Confirmo` y `Necesito cambiarlo`.

**Ejemplos que pide Meta para revisar** (podés usar estos):
`{{1}}` Laura · `{{2}}` Consultorio López · `{{3}}` Lunes, 2 de noviembre, 09:00 h ·
`{{4}}` Mamografía bilateral con Dra. Costa · `{{5}}` Av. Alameda 1240 ·
`{{6}}` Monto a abonar: $ 9.000 (OSDE) · `{{7}}` Traé DNI y la orden médica

Meta las aprueba en minutos u horas.

## 7. Conectar las respuestas (webhook)
1. En la agenda → **Configuración → WhatsApp automático** copiá la **URL de devolución** y el **Token de verificación**.
2. En **developers.facebook.com** → tu app → **WhatsApp** → **Configuración** → *Webhook* → **Editar**:
   pegá la URL y el token → **Verificar y guardar**.
3. En **Campos del webhook**, suscribite a **messages**.

## 8. Activar en la agenda
En **Configuración → WhatsApp automático**: pegá el *Phone number ID*, el *token* y la *clave secreta*,
elegí la hora del recordatorio, marcá **WhatsApp automático activado** → **Guardar**.
Probá con tu celular: **Probar confirmación** y **Probar recordatorio**.

---

## Una sola vez (lo hace el administrador): recordatorios automáticos
Los recordatorios salen solos gracias a una tarea de GitHub que avisa al servidor cada 15 minutos.
1. Inventá una clave (ej. `cron-7f3k29`).
2. **Cloudflare** → proyecto → *Settings* → *Variables and Secrets* → **Add** → *Secret* `CRON_KEY` = esa clave → *Save* → *Retry deployment*.
3. **GitHub** → repositorio → *Settings* → *Secrets and variables* → *Actions* → **New repository secret** → `CRON_KEY` = la misma clave.
4. Listo: en la pestaña **Actions** vas a ver "Recordatorios de WhatsApp" corriendo cada 15 minutos.

> Si el repositorio pasa 60 días sin cambios, GitHub pausa la tarea: entrá a *Actions* y reactivala.
> Alternativa: en **cron-job.org** (gratis) creá una tarea cada 15 minutos a
> `https://consultorios-medicos.pages.dev/api/cron/recordatorios` con el encabezado `x-cron-key: tu-clave`.

## Preguntas frecuentes
- **¿Puedo contestarle a un paciente?** Sí, desde *Panel → Mensajes de WhatsApp*, dentro de las 24 horas
  desde su último mensaje (regla de WhatsApp).
- **¿Si el paciente no tiene WhatsApp?** El mensaje no llega y en la ficha del turno aparece el motivo.
- **¿Cuánto cuesta?** Lo cobra Meta a la tarjeta del consultorio: ~US$ 0,03 por mensaje (confirmación y recordatorio).
