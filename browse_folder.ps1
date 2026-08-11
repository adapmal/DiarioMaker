Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Selecione a pasta do projeto DiarioMaker no Explorer"
$dialog.Filter = "Seletor de Pasta|*."
$dialog.CheckFileExists = $false
$dialog.CheckPathExists = $true
$dialog.ValidateNames = $false
$dialog.FileName = "Clique em Selecionar para Escolher esta Pasta"

if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $folder = [System.IO.Path]::GetDirectoryName($dialog.FileName)
    Write-Output $folder
} else {
    $fbd = New-Object System.Windows.Forms.FolderBrowserDialog
    $fbd.Description = "Selecione a pasta do projeto DiarioMaker"
    if ($fbd.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $fbd.SelectedPath
    }
}
