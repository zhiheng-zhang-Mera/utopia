param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference='Stop'
function Emit($state,$reason) { @{state=$state;reason=$reason} | ConvertTo-Json -Compress | Write-Output }
try {
 Add-Type -AssemblyName System.Runtime.WindowsRuntime
 Add-Type -TypeDefinition 'public static class UtopiaInput { public static System.Threading.Tasks.Task<string> Wait() { return System.Threading.Tasks.Task.Run(() => System.Console.ReadLine()); } }'
 $null=[Windows.Devices.Bluetooth.BluetoothAdapter,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
 $null=[Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementPublisher,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
 $null=[Windows.Devices.Bluetooth.Advertisement.BluetoothLEManufacturerData,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
 $null=[Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
 $asTask=([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1})[0]
 $operation=[Windows.Devices.Bluetooth.BluetoothAdapter]::GetDefaultAsync()
 $task=$asTask.MakeGenericMethod([Windows.Devices.Bluetooth.BluetoothAdapter]).Invoke($null,@($operation))
 if(-not $task.Wait(15000)){Emit 'ERROR' 'ADAPTER_QUERY_TIMEOUT';exit 1}
 $adapter=$task.Result
 if($null -eq $adapter){Emit 'HARDWARE_BLOCKED' 'NO_BLUETOOTH_ADAPTER';exit 0}
 if(-not $adapter.IsLowEnergySupported){Emit 'HARDWARE_BLOCKED' 'LOW_ENERGY_NOT_SUPPORTED';exit 0}
 if(-not $adapter.IsPeripheralRoleSupported){Emit 'HARDWARE_BLOCKED' 'PERIPHERAL_ROLE_NOT_SUPPORTED';exit 0}
 $publisher=New-Object Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementPublisher
 # Windows reserves service UUID AD sections. The manufacturer payload carries
 # the application UUID in canonical network byte order followed by the locator.
 $writer=New-Object Windows.Storage.Streams.DataWriter
 [byte[]]$bytes=for($i=0;$i -lt $Payload.Length;$i+=2){[Convert]::ToByte($Payload.Substring($i,2),16)}
 if($bytes.Length -ne 23){throw 'Invalid locator'}
 $writer.WriteBytes($bytes)
 $manufacturer=New-Object Windows.Devices.Bluetooth.Advertisement.BluetoothLEManufacturerData
 $manufacturer.CompanyId=65535
 [Windows.Devices.Bluetooth.Advertisement.BluetoothLEManufacturerData].GetProperty('Data').SetValue($manufacturer,$writer.DetachBuffer(),$null)
 [System.Collections.Generic.ICollection[Windows.Devices.Bluetooth.Advertisement.BluetoothLEManufacturerData]].GetMethod('Add').Invoke($publisher.Advertisement.ManufacturerData,@($manufacturer.PSObject.BaseObject))
 $publisher.Start()
 $inputTask=[UtopiaInput]::Wait()
 $previous='';$deadline=[DateTime]::UtcNow.AddSeconds(15)
 while(-not $inputTask.IsCompleted){
  $state=$publisher.Status.ToString()
  if($state -ne $previous){
   if($state -eq 'Started'){Emit 'ACTIVE' $null}
   elseif($state -eq 'Aborted'){Emit 'ERROR' 'PUBLISHER_ABORTED_RADIO_PERMISSION_OR_DRIVER';break}
   $previous=$state
  }
  if($state -ne 'Started' -and [DateTime]::UtcNow -gt $deadline){Emit 'ERROR' 'PUBLISHER_START_TIMEOUT';break}
  Start-Sleep -Milliseconds 200
 }
 $publisher.Stop();$writer.Dispose()
} catch { Emit 'ERROR' ('WINRT_FAILURE_'+$_.Exception.GetType().Name);exit 1 }
