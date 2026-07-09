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

${comercio!""} 
${rif!""}
REPORTE DE CIERRE SERVICIOS
CAJA ID: ${id!""}
CIERRE : ${fecha?string("dd/MM/yyyy HH:mm:ss")}

----------------------------------------
<#assign montoTotal = 0>
<#assign cuenta = 0>
<#list transacciones as transaccion>
<#if transaccion.codigoRespuesta == "00">

Fecha     	  :      ${transaccion.fecha?string("dd/MM/yyyy HH:mm:ss")}
<#if transaccion.nombreProveedor == "DirecTV">
Facturador    : Simple
<#else>
Facturador    : ${transaccion.nombreProveedor}
</#if>
Tipo          :       ${transaccion.tipo!""}
<#if transaccion.nombreProveedor == "DirecTV">
Nro. SmartCard: ${transaccion.servicio}
<#elseif transaccion.nombreProveedor == "Simple">
Nro. SmartCard: ${transaccion.servicio}
<#else>
Servicio  	  : ${transaccion.servicio}
</#if>
Monto     	  :      ${transaccion.monto?string("#,###,###,##0.00")}
<#assign montoTotal = montoTotal + transaccion.monto>      
<#assign cuenta = cuenta + 1>
</#if>
</#list>
<#if cuenta==0>
----------------------------------------
SIN TRANSACCIONES PENDIENTES
POR CERRAR
<#else>

Trans Aprobadas: ${cuenta}
Monto Total    : Bs. ${montoTotal?string("#,###,###,##0.00")}  
</#if>