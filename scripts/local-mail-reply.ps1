<#
.SYNOPSIS
  Send an email into the local smtp4dev server the way a real mail client would.

  Unlike Send-MailMessage, this sets a Message-ID and, when replying, the
  In-Reply-To / References headers taken from the latest email the IT Service
  Desk sent for the incident, so the whole exchange stays one chain.

.EXAMPLE
  # New request
  .\scripts\local-mail-reply.ps1 -From employee@itsm.local -Subject 'Laptop not charging' -Body 'Battery does not charge.'

  # Reply on the thread of an incident (headers + subject token filled in automatically)
  .\scripts\local-mail-reply.ps1 -From employee@itsm.local -Incident INC-001003 -Body 'Still not working.'
#>
param(
  [Parameter(Mandatory)] [string] $From,
  [string] $To = 'itsupport@cars24.com',
  [string] $Cc,
  [string] $Subject,
  [Parameter(Mandatory)] [string] $Body,
  [string] $Incident,
  [string] $SmtpHost = 'localhost',
  [int] $SmtpPort = 2525,
  [string] $Smtp4devUrl = 'http://localhost:5000'
)

$m = New-Object System.Net.Mail.MailMessage
$m.From = $From
$m.To.Add($To)
if ($Cc) { $m.CC.Add($Cc) }
$m.BodyEncoding = [System.Text.Encoding]::UTF8
$domain = ($From -split '@')[1]
$messageId = '<' + [guid]::NewGuid().ToString('N') + '@' + $domain + '>'
$m.Headers.Add('Message-ID', $messageId)
$finalBody = $Body
$inReplyTo = $null

if ($Incident) {
  # Latest mail from the service desk about this incident = what a user would press Reply on.
  $all = (Invoke-RestMethod ($Smtp4devUrl + '/api/Messages?pageSize=200')).results |
    Where-Object { ([string]$_.subject).Contains('[' + $Incident + ']') -and $_.to -contains $From } |
    Sort-Object receivedDate
  $last = $all | Select-Object -Last 1
  if (-not $last) { throw ('No email for ' + $Incident + ' addressed to ' + $From + ' found in smtp4dev - nothing to reply to.') }
  $detail = Invoke-RestMethod ($Smtp4devUrl + '/api/Messages/' + $last.id)
  $h = @{}
  foreach ($x in $detail.headers) { $h[$x.name] = $x.value }
  if ($h['Message-ID']) {
    $inReplyTo = $h['Message-ID']
    $m.Headers.Add('In-Reply-To', $inReplyTo)
    $refs = @()
    if ($h['References']) { $refs += $h['References'] }
    $refs += $inReplyTo
    $m.Headers.Add('References', ($refs -join ' '))
  }
  if (-not $Subject) {
    $Subject = $h['Subject']
    if ($Subject -notmatch '^\s*re:') { $Subject = 'RE: ' + $Subject }
  }
  # Quote the previous message like a mail client does (the pipeline strips it).
  $prev = (Invoke-WebRequest ($Smtp4devUrl + '/api/Messages/' + $last.id + '/source') -UseBasicParsing).Content
  $quoted = (($prev -split "`r?`n") | ForEach-Object { '> ' + $_ }) -join "`n"
  $finalBody = $Body + "`n`nOn " + $last.receivedDate + ', IT Service Desk wrote:' + "`n" + $quoted
}
if (-not $Subject) { throw 'Subject is required for a new request.' }
$m.Subject = $Subject
$m.Body = $finalBody

(New-Object System.Net.Mail.SmtpClient($SmtpHost, $SmtpPort)).Send($m)
$note = ''
if ($inReplyTo) { $note = ' (In-Reply-To ' + $inReplyTo + ')' }
Write-Output ('Sent: "' + $Subject + '" from ' + $From + ' with Message-ID ' + $messageId + $note)
