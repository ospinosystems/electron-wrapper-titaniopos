<?php
chdir("c:\xampp\htdocs\projects\titaniopos-electron\fiscal-server");
$output = array();
$rc = 0;
exec("IntTFHKA.exe SendCmd(I0X)", $output, $rc);
echo "RC:" . $rc . "\n";
echo "OUTPUT:" . implode("\n", $output) . "\n";
echo "STATUS:" . file_get_contents("Status_Error.txt") . "\n";
echo "RETORNO:" . file_get_contents("Retorno.txt") . "\n";
?>
