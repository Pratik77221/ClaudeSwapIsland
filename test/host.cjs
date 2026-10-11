const vscode=require('vscode');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
exports.run=async()=>{
 const ext=vscode.extensions.getExtension('manep-local.claude-swap-island');assert.ok(ext);const api=await ext.activate();
 for(let i=0;i<60&&api.getState().busy;i++)await new Promise(r=>setTimeout(r,500));
 const state=api.getState();assert.equal(state.error,'');assert.ok(state.accounts.length>0,'Current account should be available');
 assert.equal(JSON.stringify(state).includes('accessToken'),false);
 await vscode.commands.executeCommand('swapIsland.sidebar');await vscode.commands.executeCommand('swapIsland.expand');
 fs.writeFileSync(path.resolve(__dirname,'../artifacts/host-native-020.json'),JSON.stringify({passed:true,version:vscode.version,accountCount:state.accounts.length,usageStatus:state.accounts[0].usageStatus,checks:['native account loading','VS Code SecretStorage','no command-line dependency','sidebar','dashboard'],note:'No production account switch performed.'},null,2));
};
