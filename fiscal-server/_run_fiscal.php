<?php
chdir("c:\xampp\htdocs\projects\titaniopos-electron\fiscal-server");
shell_exec("IntTFHKA.exe SendCmd(I0X)");
echo "STATUS:" . file_get_contents("Status_Error.txt") . "\n";
echo "RETORNO:" . file_get_contents("Retorno.txt") . "\n";
?>
