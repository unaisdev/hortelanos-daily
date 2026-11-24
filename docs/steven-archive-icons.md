# Iconos de equipos pasados de Daily Steven

El pack 0.1.2 exporta el ID de especie almacenado en la ROM. La lectura de esa ficha está vinculada al SHA-256 de la ROM mediante los símbolos del pack. [La tabla de Steven](../runner/steven-archive-sprites.js) convierte los IDs de la expansión fijada en claves canónicas y las cruza con [las claves de Gold](../runner/archive-data.js). Por ejemplo, Treecko es el 252 en la expansión y utiliza el icono 277 del lanzador. Nidoran hembra y macho tienen claves distintas. El mapeo se habilita para las ROM de la 0.1.2 a la 0.1.7 verificadas. Las ROM de hash desconocido conservan las fichas de texto hasta verificar su correspondencia.

El catálogo de iconos de Gold tiene un solo icono por especie base. Unown, Castform y Deoxys requieren una coincidencia de forma que ese catálogo no garantiza. En Unown, el ID base tampoco basta para identificar la letra. Esas familias, los IDs desconocidos y los iconos que no se puedan cargar muestran un guion con la etiqueta «Icono no disponible». El nombre y los datos de la ficha siguen visibles. Los iconos disponibles representan la especie, como en Gold.

La prueba recorre los 386 IDs de tercera generación, comprueba que los 383 iconos resueltos existen y son distintos y verifica el tratamiento de formas ambiguas. Gold y Red conservan su propia numeración.
