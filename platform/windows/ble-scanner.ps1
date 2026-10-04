param([int]$TimeoutMs=5000)
$ErrorActionPreference='Stop'
$watcher=$null
$receivedToken=$null
function Emit($state,$reason) { @{state=$state;reason=$reason} | ConvertTo-Json -Compress | Write-Output }
try {
 Add-Type -AssemblyName System.Runtime.WindowsRuntime
 # Windows PowerShell's event manager rejects WinRT events. Keep the callback
 # off the PowerShell runspace and drain a bounded queue on this thread instead.
 Add-Type -TypeDefinition @'
using System.Collections.Concurrent;
public static class UtopiaBleEvents {
 private static readonly ConcurrentQueue<object> Queue = new ConcurrentQueue<object>();
 public static void Received(object sender, object args) { if (Queue.Count < 64) Queue.Enqueue(args); }
 public static object Take() { object value; return Queue.TryDequeue(out value) ? value : null; }
}
'@
 $null=[Windows.Devices.Bluetooth.BluetoothAdapter,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
 $null=[Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
 $null=[Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementReceivedEventArgs,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
 $null=[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]
 $null=[Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
 $asTask=([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1})[0]
 $task=$asTask.MakeGenericMethod([Windows.Devices.Bluetooth.BluetoothAdapter]).Invoke($null,@([Windows.Devices.Bluetooth.BluetoothAdapter]::GetDefaultAsync()))
 if(-not $task.Wait(2500)){Emit 'ERROR' 'ADAPTER_QUERY_TIMEOUT';exit 1}
 $adapter=$task.Result
 if($null -eq $adapter){Emit 'HARDWARE_BLOCKED' 'NO_BLUETOOTH_ADAPTER';exit 0}
 if(-not $adapter.IsLowEnergySupported){Emit 'HARDWARE_BLOCKED' 'LOW_ENERGY_NOT_SUPPORTED';exit 0}
 $radioTask=$asTask.MakeGenericMethod([Windows.Devices.Radios.Radio]).Invoke($null,@($adapter.GetRadioAsync()))
 if(-not $radioTask.Wait(2500)){Emit 'ERROR' 'ADAPTER_QUERY_TIMEOUT';exit 1}
 if($radioTask.Result.State.ToString() -ne 'On'){Emit 'HARDWARE_BLOCKED' 'BLUETOOTH_DISABLED';exit 0}
 $watcher=New-Object Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher
 $watcher.ScanningMode='Active'
 $eventType=[Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher]
 $handler=[Delegate]::CreateDelegate($eventType.GetEvent('Received').EventHandlerType,[UtopiaBleEvents].GetMethod('Received'))
 $receivedToken=$eventType.GetMethod('add_Received').Invoke($watcher,@($handler))
 $watcher.Start()
 $deadline=[DateTime]::UtcNow.AddMilliseconds([Math]::Min(5000,[Math]::Max(100,$TimeoutMs)))
 $seen=New-Object 'System.Collections.Generic.HashSet[string]'
 while([DateTime]::UtcNow -lt $deadline){
  if($watcher.Status.ToString() -eq 'Aborted'){Emit 'ERROR' 'BLUETOOTH_SCAN_PERMISSION_OR_DRIVER';exit 1}
  Start-Sleep -Milliseconds 100
  while($null -ne ($raw=[UtopiaBleEvents]::Take())){
    $received=[Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementReceivedEventArgs]$raw
    foreach($data in $received.Advertisement.ManufacturerData){
     if($data.CompanyId -ne 65535 -or $data.Data.Length -ne 23 -or $seen.Count -ge 32){continue}
     $reader=[Windows.Storage.Streams.DataReader]::FromBuffer($data.Data)
     try { [byte[]]$bytes=New-Object byte[] 23; $reader.ReadBytes($bytes) } finally { $reader.Dispose() }
     $payload=([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
     if(-not $payload.StartsWith('6f9a00016c534b92a31975746f70696101') -or -not $seen.Add($payload)){continue}
     @{payload=$payload} | ConvertTo-Json -Compress | Write-Output
    }
  }
 }
 Emit 'DONE' $null
} catch { Emit 'ERROR' 'BLUETOOTH_SCAN_PERMISSION_OR_DRIVER';exit 1 }
finally {
 if($null -ne $watcher){$watcher.Stop()}
 if($null -ne $receivedToken){$eventType.GetMethod('remove_Received').Invoke($watcher,@($receivedToken))}
}
