[33mcommit de3d0a2fac08ad470660a4825d23596812b29225[m[33m ([m[1;36mHEAD[m[33m -> [m[1;32mmain[m[33m)[m
Author: Ecodia Factory <factory@ecodia.au>
Date:   Thu Apr 2 15:00:51 2026 +0000

    Factory: Investigate the 'Session orphaned — VPS reboot or process crash' error that occurred in the last 7 d
    
    CC Session: 0fde9e54-af6a-470c-b23e-e9f277016e33
    Confidence: 0.65
    Trigger: scheduled
    
    Co-Authored-By: Claude Code <noreply@anthropic.com>

[1mdiff --git a/src/server.js b/src/server.js[m
[1mindex e565b2b..6484752 100644[m
[1m--- a/src/server.js[m
[1m+++ b/src/server.js[m
[36m@@ -22,16 +22,21 @@[m [masync function cleanupOrphanedSessions() {[m
     RETURNING id, started_at[m
   `[m
   if (orphans.length > 0) {[m
[31m-    logger.warn(`Marked ${orphans.length} orphaned CC session(s) on startup (hard kill — not caught by SIGTERM handler)`, {[m
[32m+[m[32m    logger.warn(`Marked ${orphans.length} orphaned CC session(s) on startup (hard kill — not caught by SIGTERM/SIGINT handler)`, {[m
       ids: orphans.map(r => r.id),[m
[32m+[m[32m      startedAt: orphans.map(r => r.started_at),[m
     })[m
   }[m
 }[m
 [m
 // Graceful shutdown — registered at module level so it fires regardless of[m
[31m-// whether the server has finished starting. PM2 sends SIGTERM on restart.[m
[31m-process.on('SIGTERM', async () => {[m
[31m-  logger.info('SIGTERM received — shutting down')[m
[32m+[m[32m// whether the server has finished starting. PM2 sends SIGTERM on restart/delete[m
[32m+[m[32m// and SIGINT in some shutdown paths.[m
[32m+[m[32mlet shuttingDown = false[m
[32m+[m[32masync function gracefulShutdown(signal) {[m
[32m+[m[32m  if (shuttingDown) return // Prevent double-shutdown from SIGTERM+SIGINT race[m
[32m+[m[32m  shuttingDown = true[m
[32m+[m[32m  logger.info(`${signal} received — shutting down`)[m
 [m
   // Stop active CC sessions gracefully so they don't become orphans[m
   try {[m
[36m@@ -42,7 +47,7 @@[m [mprocess.on('SIGTERM', async () => {[m
       // stopAllSessions kills child processes and marks DB as 'stopped'[m
       await Promise.race([[m
         ccService.stopAllSessions('Process restarting — session stopped gracefully'),[m
[31m-        new Promise(resolve => setTimeout(resolve, 8000)), // Don't block shutdown >8s[m
[32m+[m[32m        new Promise(resolve => setTimeout(resolve, 10000)), // Don't block shutdown >10s (kill_timeout is 12s)[m
       ])[m
     }[m
   } catch (err) {[m
[36m@@ -54,7 +59,9 @@[m [mprocess.on('SIGTERM', async () => {[m
     maintenance.stop()[m
   } catch {}[m
   server.close(() => process.exit(0))[m
[31m-})[m
[32m+[m[32m}[m
[32m+[m[32mprocess.on('SIGTERM', () => gracefulShutdown('SIGTERM'))[m
[32m+[m[32mprocess.on('SIGINT', () => gracefulShutdown('SIGINT'))[m
 [m
 server.listen(env.PORT, async () => {[m
   logger.info(`Ecodia API running on :${env.PORT}`)[m
