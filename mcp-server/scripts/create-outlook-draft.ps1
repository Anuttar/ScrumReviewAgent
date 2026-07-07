# Creates a draft email in Outlook desktop application
# Usage: .\create-outlook-draft.ps1 -Subject "..." -Body "..." -To "..." -BodyFormat "HTML"
param(
    [Parameter(Mandatory=$true)]
    [string]$Subject,

    [Parameter(Mandatory=$true)]
    [string]$Body,

    [Parameter(Mandatory=$false)]
    [string]$To = "",

    [Parameter(Mandatory=$false)]
    [ValidateSet("HTML", "Plain")]
    [string]$BodyFormat = "HTML"
)

try {
    # Connect to running Outlook instance or start one
    try {
        $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application")
    } catch {
        $outlook = New-Object -ComObject Outlook.Application
    }

    $mail = $outlook.CreateItem(0)  # 0 = olMailItem

    $mail.Subject = $Subject

    if ($BodyFormat -eq "HTML") {
        $mail.HTMLBody = $Body
    } else {
        $mail.Body = $Body
    }

    if ($To -ne "") {
        $mail.To = $To
    }

    # Save as draft (does not send)
    $mail.Save()

    $result = @{
        success = $true
        message = "Draft email created successfully in Outlook"
        subject = $Subject
        to = if ($To -ne "") { $To } else { "(no recipients - add manually)" }
    } | ConvertTo-Json

    Write-Output $result
} catch {
    $result = @{
        success = $false
        message = "Failed to create draft: $($_.Exception.Message)"
    } | ConvertTo-Json

    Write-Output $result
    exit 1
}
