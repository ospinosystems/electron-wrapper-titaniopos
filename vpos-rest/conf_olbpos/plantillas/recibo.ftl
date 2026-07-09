<#-- 
Es una plantilla freemaker. Puede consultar más información en: http://freemarker.org/docs/index.html
Uso básico
  Use <#list transacciones as transaccion> para indicar que deben recorrerse todas las transacciones de servicio
  para mostrar su contenido, Ejemplo:
    <#list transacciones as transaccion>
      ${transaccion.proveedor}
      ...
    </#list>
* Para el texto "Falla: " de la línea 30 puede usar un máximo de 10 caracteres antes de la variable ya que
este valor se toma en cuenta para conocer cómo se deben cortar las palabras.
* Los siguientes caracteres NO deben ser usados en las plantillas [áàäéèëíìïóòöúùuñÁÀÄÉÈËÍÌÏÓÒÖÚÙÜÑçÇ´¿¨]    
-->

        RECIBO DE SERVICIOS

COMERCIO: ${comercio!""}         
RIF     : ${rif!""}
FECHA   : ${fecha?string("dd/MM/yyyy HH:mm:ss")}
TRANS.  : ${secuencia!""}
CAJA    : ${vtid!""}

        TRANSACCIONES

<#assign montoTotal = 0>
<#assign montoTotalRechazadas = 0>
<#list transacciones as transaccion>
<#assign movistar = 0>
<#assign ldi = 0>
<#assign digitel = 0>
<#assign simpletv = 0>
<#assign netuno = 0>
<#if transaccion.nombreProveedor == "DirecTV">
Facturador      : Simple
<#else>
Facturador      : ${transaccion.nombreProveedor}
</#if>
Tipo de Servicio: ${transaccion.tipo!""}
<#if  transaccion.nombreProveedor == "Simple">
Nro. SmartCard  : ${transaccion.servicio}
<#elseif transaccion.nombreProveedor == "NetUno">
Cédula o RIF    : ${transaccion.servicio}
<#elseif transaccion.nombreProveedor == "DirecTV">
Nro. SmartCard  : ${transaccion.servicio}
<#else>
Nro. Servicio   : ${transaccion.servicio}
</#if>
<#if transaccion.nombreProveedor == "NetUno" && transaccion.codigoRespuesta == "00">
Nombre Abonado  : ${transaccion.parametros.item_nombre_cliente}
Código NetUno   : ${transaccion.parametros.item_codigo_abonado}
	<#assign netuno = 1>
</#if>
Monto Bs.       : ${transaccion.monto?string("#,###,###,##0.00")}
<#if transaccion.codigoRespuesta != "00">
Falla           : ${transaccion.motivoFalla!""}
<#else>
Aprobación      : ${transaccion.codigoAprobacion!""}
</#if>
<#if transaccion.tipo == "Larga Distancia Internacional" && transaccion.codigoRespuesta == "00">
Pin	     : ${transaccion.parametros.item_pin}
Acceso   : ${transaccion.parametros.item_access_prefix}
Soporte  : ${transaccion.parametros.item_support_prefix}
</#if>
<#if transaccion.nombreProveedor == "Simple" && transaccion.codigoRespuesta == "00">
Referencia      : ${transaccion.parametros.item_paymentReference}
Dias Prog Disponibles: ${transaccion.providerPrivate}
Fecha de Desconexión : ${transaccion.balanceOver}
	<#assign simpletv = 1>
</#if>
<#if transaccion.nombreProveedor == "DirecTV" && transaccion.codigoRespuesta == "00">
Referencia      : ${transaccion.parametros.item_paymentReference}
Dias Prog Disponibles: ${transaccion.parametros.item_daysAvailableProgramming}
Fecha de Desconexión : ${transaccion.parametros.item_billingDate?substring(8,10)}/${transaccion.parametros.item_billingDate?substring(5,7)}/${transaccion.parametros.item_billingDate?substring(0,4)}
	<#assign simpletv = 1>
</#if>
<#if transaccion.nombreProveedor == "Telefónica">
   <#assign movistar = 1>
</#if>
<#if transaccion.tipo == "Larga Distancia Internacional" && transaccion.codigoRespuesta == "00">
   <#assign ldi = 1>
</#if>
<#if transaccion.nombreProveedor == "Digitel">
   <#assign digitel = 1>
</#if>
<#if transaccion.codigoRespuesta == "00">
   <#assign montoTotal = montoTotal + transaccion.monto>
<#else>
   <#assign montoTotalRechazadas = montoTotalRechazadas + transaccion.monto>
</#if>
<#if transaccion.parametros['item_mensaje']?? >
Mensaje         : ${transaccion.parametros.item_mensaje}
</#if>
<#if movistar == 1>

Consulte su saldo a través de 
la App Mi Movistar o el 811.
Consulta nuestros planes y servicios 
en www.movistar.com.ve y actívalos por
Mi Movistar.
  
</#if>
<#if ldi == 1>

Para acceder al servicio de  llamadas
Internacionales comuníquese al número
de acceso, ingrese el pin comprado y 
posteriormente el número al cual desea 
llamar.

</#if>
<#if simpletv == 1>

Simple informa que tu recarga será
efectiva en un lapso máximo de 24h.

</#if>
<#if digitel == 1>

Para más información comuníquese al 121
desde su Digitel o al 04129121121.

</#if>
<#if netuno == 1>
 
</#if>
<#if transaccion.nombreProveedor == "Inter">

</#if>
</#list>

Montos Totales
<#if montoTotal != 0>
Bs. Aprobados : ${montoTotal?string("#,###,###,##0.00")}
</#if>
<#if montoTotalRechazadas != 0>
Bs. Rechazados: ${montoTotalRechazadas?string("#,###,###,##0.00")}
</#if>