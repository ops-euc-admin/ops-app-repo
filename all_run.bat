@echo off

:: ������ Operator�A�v���p�ݒ荀�� ������
set "COMMAND_operator_1=C:\Users\ops-euc-admin\release\ngrok http --domain=gradually-meet-foxhound.ngrok-free.app 3001"
set "FOLDER_operator_2=C:\Users\ops-euc-admin\release\ops-app-repo\slack-dify-operator"
set "COMMAND_operator_2=node app.js 3001"

:: ������ MSO�A�v���p�ݒ荀�� ������
set "FOLDER_mso=C:\Users\ops-euc-admin\release\ops-app-repo\slack-dify-mso"
set "COMMAND_mso=node index.js"

:: ������ Ops Deep Research�A�v���p�ݒ荀�� ������
set "FOLDER_ops_deep_research=C:\Users\ops-euc-admin\release\ops-app-repo\slack-dify-ops-deep-research"
set "COMMAND_ops_deep_research=node index.js"

:: ������ �ݒ�͂����܂� ������


:: Operator�p��PowerShell�E�B���h�E���N��
echo Starting PowerShell in %FOLDER1%...
start "PS Window 1" powershell -NoExit -Command "Set-Location '%FOLDER_operator_2%'; %COMMAND_operator_1%"
start "PS Window 2" powershell -NoExit -Command "Set-Location '%FOLDER_operator_2%'; %COMMAND_operator_2%"

:: MSO�p��PowerShell�E�B���h�E���N��
echo Starting PowerShell in %FOLDER2%...
start "PS Window 3" powershell -NoExit -Command "Set-Location '%FOLDER_mso%'; %COMMAND_mso%"

:: Ops-Deep-Research�p��PowerShell�E�B���h�E���N��
echo Starting PowerShell in %FOLDER2%...
start "PS Window 4" powershell -NoExit -Command "Set-Location '%FOLDER_ops_deep_research%'; %COMMAND_ops_deep_research%"

echo Batch file finished.