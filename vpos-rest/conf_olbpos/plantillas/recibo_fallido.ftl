<#-- 
Es una plantilla freemaker. Puede consultar más información en: http://freemarker.org/docs/index.html
Uso básico
  Use <#list transacciones as transaccion> para indicar que deben recorrerse todas las transacciones de servicio
  para mostrar su contenido, Ejemplo:
    <#list transacciones as transaccion>
      ${transaccion.proveedor}
      ...
    </#list>
* Los siguientes caracteres NO deben ser usados en las plantillas [áàäéèëíìïóòöúùuñÁÀÄÉÈËÍÌÏÓÒÖÚÙÜÑçÇ´¿¨]    
-->

        RECIBO DE SERVICIOS

COMERCIO: ${comercio!""} 		
RIF     : ${rif!""}
FECHA   : ${fecha?string("dd/MM/yyyy HH:mm:ss.SSS")}
CAJA    : ${vtid!""}

TRANSACCIÓN FALLIDA:
COD. ERROR: ${coderror}   
${error}