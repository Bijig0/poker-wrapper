; The Poker Wrapper installer — PokerWrapperSetup-<version>.exe. Built by setup\buildPackage.ts --installer (and every
; --publish), which stages the code zip + the runtime part (bin\bun.exe, bin\rclone.exe) into one folder and runs
;   ISCC /DAppVersion=<version> /DStageDir=<stage>\PokerWrapper /DOutputDir=<out> setup\installer\PokerWrapper.iss
;
; What a player sees: Welcome -> Download key (paste it, or "Load key file..." / found by itself next to the setup) ->
; desktop icons? -> Install. After copying, setup\setup.ps1 -Installer runs in a window of its own: the chart data
; (~3 GB, with progress), Chrome/Brave if missing, the three background services, the GTO Wizard sign-in window, the
; checklist. Start menu + desktop get exactly two icons: Poker Wrapper and Poker Dashboard.
;
; Per-user (no admin prompt), into %LOCALAPPDATA%\Programs\PokerWrapper. Running it again = repair/upgrade: it stops the
; running copy first (setup\uninstall.ps1 -StopOnly; refuses mid-session) and keeps hands, settings and the key.
; Later versions arrive through the app itself (the setup page's "Update available" bar -> setup\update.ps1).
; Uninstall (Settings > Apps): removes the services and the program, and ASKS before deleting the hand history.
;
; Command line (besides Inno's own /SILENT, /VERYSILENT, /DIR=): /KEYFILE=<PokerWrapper-key.txt> fills the key page;
; /NOSERVICES installs without registering or starting the services (a test copy beside a live install).

#ifndef AppVersion
  #define AppVersion "0.0.0.0"
#endif
#ifndef StageDir
  #error Define StageDir: the unpacked code zip + runtime part (setup\buildPackage.ts does this)
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

[Setup]
AppId={{46D7BF98-32ED-4B32-AC8A-51C161BD00AD}
AppName=Poker Wrapper
AppVersion={#AppVersion}
AppVerName=Poker Wrapper {#AppVersion}
AppPublisher=Poker Wrapper
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\PokerWrapper
DisableDirPage=yes
DefaultGroupName=Poker Wrapper
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=PokerWrapperSetup-{#AppVersion}
SetupIconFile={#StageDir}\ignition-study-wrapper\ignition-study.ico
UninstallDisplayIcon={app}\ignition-study-wrapper\ignition-study.ico
UninstallDisplayName=Poker Wrapper
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; setup\uninstall.ps1 -StopOnly (PrepareToInstall) stops what holds our files; no Restart Manager prompt on top of it
CloseApplications=no
RestartApplications=no

[Messages]
WelcomeLabel2=This installs the Poker Wrapper (the study panel beside your poker table) and its dashboard.%n%nHave your download key ready (PokerWrapper-key.txt). After the files are copied, setup downloads about 3 GB of chart data (8 GB once unpacked), so leave it running for a few minutes.
FinishedLabel=The Poker Wrapper is installed.%n%nOne more thing, once: a Chrome window opened on GTO Wizard. Sign in there and leave it open (you can minimise it).%n%nThen open Poker Wrapper from the Start menu or the desktop.

[Tasks]
Name: "desktopicon"; Description: "Put Poker Wrapper and Poker Dashboard on the desktop"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Poker Wrapper"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\ignition-study-wrapper\run-wrapper.vbs"""; WorkingDir: "{app}\ignition-study-wrapper"; IconFilename: "{app}\ignition-study-wrapper\ignition-study.ico"; Comment: "The study panel beside your poker table"
Name: "{group}\Poker Dashboard"; Filename: "http://localhost:2000/"; IconFilename: "{app}\gto-trainer\study-tool.ico"; Comment: "Your sessions and hands"
Name: "{userdesktop}\Poker Wrapper"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\ignition-study-wrapper\run-wrapper.vbs"""; WorkingDir: "{app}\ignition-study-wrapper"; IconFilename: "{app}\ignition-study-wrapper\ignition-study.ico"; Tasks: desktopicon
Name: "{userdesktop}\Poker Dashboard"; Filename: "http://localhost:2000/"; IconFilename: "{app}\gto-trainer\study-tool.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup\setup.ps1"" -Installer {code:KeyArg}"; StatusMsg: "Downloading the chart data and starting the services (a few minutes the first time)..."; Flags: waituntilterminated
Filename: "{sys}\wscript.exe"; Parameters: """{app}\ignition-study-wrapper\run-wrapper.vbs"""; WorkingDir: "{app}\ignition-study-wrapper"; Description: "Open Poker Wrapper"; Flags: postinstall nowait skipifsilent

[Code]
var
  KeyPage: TInputQueryWizardPage;
  StratPage: TInputOptionWizardPage;   // what the player plays: only that strategy's data is downloaded
  KeyNote: TNewStaticText;
  KeyExtra: TStringList;     // the other lines of a loaded key file (provider, acl, region...), passed on as they are

function HasKey(): Boolean;
begin
  Result := FileExists(WizardDirValue + '\config\rclone.conf');
end;

procedure LoadKeyFile(const Path: String);
var
  Lines: TArrayOfString;
  I, P: Integer;
  K, V: String;
begin
  if not LoadStringsFromFile(Path, Lines) then begin
    KeyNote.Caption := 'Could not read ' + Path;
    exit;
  end;
  KeyExtra.Clear;
  for I := 0 to GetArrayLength(Lines) - 1 do begin
    P := Pos('=', Lines[I]);
    if P > 0 then begin
      K := Lowercase(Trim(Copy(Lines[I], 1, P - 1)));
      V := Trim(Copy(Lines[I], P + 1, MaxInt));
      if K = 'access_key_id' then KeyPage.Values[0] := V
      else if K = 'secret_access_key' then KeyPage.Values[1] := V
      else if K = 'endpoint' then KeyPage.Values[2] := V
      else if (K <> '') and (K <> 'type') and (K[1] <> '#') and (K[1] <> ';') and (K[1] <> '[') then KeyExtra.Add(K + ' = ' + V);
    end;
  end;
  KeyNote.Caption := 'Key loaded from ' + Path;
end;

procedure LoadKeyClick(Sender: TObject);
var
  F: String;
begin
  F := '';
  if GetOpenFileName('Choose your download key (PokerWrapper-key.txt)', F, ExpandConstant('{src}'),
                     'Key files (*.txt;*.conf)|*.txt;*.conf|All files (*.*)|*.*', 'txt') then
    LoadKeyFile(F);
end;

procedure InitializeWizard();
var
  B: TNewButton;
  Found: String;
begin
  KeyExtra := TStringList.Create;
  KeyPage := CreateInputQueryPage(wpWelcome, 'Download key',
    'Charts, chart data and updates come through your download key.',
    'Press "Load key file..." and choose PokerWrapper-key.txt, or paste the three values from it.');
  KeyPage.Add('Access key ID:', False);
  KeyPage.Add('Secret access key:', True);
  KeyPage.Add('Endpoint (https://<account>.r2.cloudflarestorage.com, or just the account ID):', False);

  // the strategy page: one choice today (setup\buildPackage.ts STRATEGIES is the list; a new one is a release)
  StratPage := CreateInputOptionPage(KeyPage.ID, 'What will you play?',
    'Only the charts and data for it are downloaded.',
    'Pick the tables you play. Setup fetches the data that strategy needs (about 3 GB) and nothing else.', True, False);
  StratPage.Add('Ignition 6-max NL200 (ring games) - the 6-max preflop charts, about 3 GB');
  StratPage.Values[0] := True;

  B := TNewButton.Create(KeyPage);
  B.Parent := KeyPage.Surface;
  B.Caption := 'Load key file...';
  B.Width := ScaleX(120);
  B.Height := ScaleY(25);
  B.Top := KeyPage.Edits[2].Top + KeyPage.Edits[2].Height + ScaleY(14);
  B.Left := 0;
  B.OnClick := @LoadKeyClick;

  KeyNote := TNewStaticText.Create(KeyPage);
  KeyNote.Parent := KeyPage.Surface;
  KeyNote.Top := B.Top + ScaleY(5);
  KeyNote.Left := B.Width + ScaleX(12);
  KeyNote.Width := KeyPage.SurfaceWidth - KeyNote.Left;
  KeyNote.AutoSize := False;
  KeyNote.Caption := '';

  // /KEYFILE=<path> (a silent install), else handed over together: next to the setup file, or in Downloads
  Found := ExpandConstant('{param:KEYFILE|}');
  if Found = '' then Found := ExpandConstant('{src}\PokerWrapper-key.txt');
  if not FileExists(Found) then Found := ExpandConstant('{%USERPROFILE}\Downloads\PokerWrapper-key.txt');
  if FileExists(Found) then LoadKeyFile(Found);
end;

function HasSwitch(const Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Name) = 0 then Result := True;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = KeyPage.ID) and HasKey() and (KeyPage.Values[0] = '') and (KeyNote.Caption = '') then
    KeyNote.Caption := 'This computer already has a key. Leave the boxes empty to keep it.';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  E: String;
begin
  Result := True;
  if CurPageID <> KeyPage.ID then exit;
  KeyPage.Values[0] := Trim(KeyPage.Values[0]);
  KeyPage.Values[1] := Trim(KeyPage.Values[1]);
  E := Trim(KeyPage.Values[2]);
  if (KeyPage.Values[0] = '') and (KeyPage.Values[1] = '') and (E = '') and HasKey() then exit;
  if (KeyPage.Values[0] = '') or (KeyPage.Values[1] = '') or (E = '') then begin
    MsgBox('All three values are needed. The easiest way: press "Load key file..." and choose PokerWrapper-key.txt.', mbError, MB_OK);
    Result := False;
    exit;
  end;
  // just the Cloudflare account ID (32 hex characters) is enough: it becomes the endpoint
  if (Pos('://', E) = 0) and (Length(E) = 32) then E := 'https://' + E + '.r2.cloudflarestorage.com';
  if Pos('https://', Lowercase(E)) <> 1 then begin
    MsgBox('The endpoint should look like https://<account>.r2.cloudflarestorage.com', mbError, MB_OK);
    Result := False;
    exit;
  end;
  KeyPage.Values[2] := E;
end;

// the key, for setup.ps1 -KeyFile: written to {tmp} (deleted when this setup exits; setup.ps1 deletes it after use)
procedure WriteKeyFile();
var
  L: TStringList;
  I: Integer;
  HasProvider, HasAcl: Boolean;
begin
  if KeyPage.Values[0] = '' then exit;
  L := TStringList.Create;
  try
    HasProvider := False;
    HasAcl := False;
    for I := 0 to KeyExtra.Count - 1 do begin
      if Pos('provider', KeyExtra[I]) = 1 then HasProvider := True;
      if Pos('acl', KeyExtra[I]) = 1 then HasAcl := True;
      L.Add(KeyExtra[I]);
    end;
    if not HasProvider then L.Add('provider = Cloudflare');
    if not HasAcl then L.Add('acl = private');
    L.Add('access_key_id = ' + KeyPage.Values[0]);
    L.Add('secret_access_key = ' + KeyPage.Values[1]);
    L.Add('endpoint = ' + KeyPage.Values[2]);
    L.SaveToFile(ExpandConstant('{tmp}\key.txt'));
  finally
    L.Free;
  end;
end;

// setup.ps1's arguments after -Installer: the key, and /NOSERVICES = do not register or start the three services (a
// test install on a machine whose own Poker Wrapper already holds :2000 / :8777 / :7700)
function KeyArg(Param: String): String;
var
  Strat: String;
begin
  Result := '';
  if FileExists(ExpandConstant('{tmp}\key.txt')) then Result := '-KeyFile "' + ExpandConstant('{tmp}\key.txt') + '"';
  if HasSwitch('/NOSERVICES') then Result := Result + ' -SkipTasks';
  // the folder this setup runs from: PokerWrapper-data-*.zip files beside it (a USB stick, C:\Users\Public\PokerWrapper)
  // are unpacked instead of downloaded
  Result := Result + ' -DataDir "' + ExpandConstant('{src}') + '"';
  // /STRATEGY=<id> (a silent install) wins; else the page's pick — the only row today is ign200-6max
  Strat := ExpandConstant('{param:STRATEGY|}');
  if (Strat = '') and (StratPage <> nil) and StratPage.Values[0] then Strat := 'ign200-6max';
  if Strat <> '' then Result := Result + ' -Strategy ' + Strat;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then WriteKeyFile();
end;

function PowerShell(const Script, Args: String): Integer;
begin
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
              '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '" ' + Args, '', SW_HIDE, ewWaitUntilTerminated, Result) then
    Result := -1;
end;

// an upgrade or a repair: stop the copy that is running (its bun.exe and supervisors hold files we replace)
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  S: String;
begin
  Result := '';
  S := WizardDirValue + '\setup\uninstall.ps1';
  if FileExists(S) and (PowerShell(S, '-StopOnly') = 2) then
    Result := 'A Poker Wrapper session is running. End it on the panel, then run this setup again.';
end;

procedure DeleteChartBodies(const Dir: String);
var
  F: TFindRec;
begin
  if FindFirst(Dir + '\*.json.gz', F) then begin
    try
      repeat
        DeleteFile(Dir + '\' + F.Name);
      until not FindNext(F);
    finally
      FindClose(F);
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  App, S: String;
begin
  App := ExpandConstant('{app}');
  if CurUninstallStep = usUninstall then begin
    // before any file goes: stop everything this install runs, remove its three services and the GTO Wizard window
    S := App + '\setup\uninstall.ps1';
    if FileExists(S) then PowerShell(S, '');
  end;
  if CurUninstallStep = usPostUninstall then begin
    if SuppressibleMsgBox('Also delete your hand history, sessions and settings?' + #13#10#13#10 +
                          'Choose No to keep them: installing again in the same place picks them up.',
                          mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
      DelTree(App, True, True, True)
    else begin
      // kept: the records. Gone either way: the big downloads (fetched again by a new install), the packages, the key
      DeleteFile(App + '\gto-trainer\apps\api\data\hrc6max-preflop.sqlite');
      DelTree(App + '\gto-trainer\apps\api\data\mes_turn', True, True, True);
      DeleteFile(App + '\gto-trainer\apps\api\data\limp_node_trust.json');
      DeleteChartBodies(App + '\gto-trainer\apps\api\data\charts');
      DelTree(App + '\bin', True, True, True);
      DelTree(App + '\gto-trainer\node_modules', True, True, True);
      DelTree(App + '\config\parts', True, True, True);
      DeleteFile(App + '\config\installed-data.json');
      DeleteFile(App + '\config\rclone.conf');
    end;
  end;
end;
