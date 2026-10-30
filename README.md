# Agenda de turnos para consultorios médicos

Sistema de turnos online para consultorios y centros de diagnóstico.

- **Vista paciente:** elige consulta o estudio, día y horario libre; carga DNI, obra social y número de afiliado; recibe la preparación del estudio y confirma por WhatsApp.
- **Panel del consultorio:** agenda diaria por médico y por equipo (mamografía, ecografía, densitometría), confirmaciones y recordatorios por WhatsApp, bloqueos de horario y control de órdenes médicas.

- **Configuración (desde la web):** tipo de agenda (solo turnos o consultas y estudios), profesionales con horarios e intervalos, estudios que realiza cada uno, turnos combinados, valores por obra social con cálculo de la diferencia que abona el paciente, preparación y notas por estudio.

La configuración de ejemplo está en el bloque `DEFAULTS` al inicio del `<script>` de `index.html`.

- **App instalable (PWA):** se instala en el celular o la computadora desde el navegador.
- **Base de datos:** se conecta a Supabase (gratis) siguiendo la [guía](GUIA-SUPABASE.md). Sin conectar, funciona en modo demostración (usuario `demo@consultorio.com`, clave `demo1234`).
