# Managing rules

- `/autodelete edit channel` changes a rule. It takes the same options as `/autodelete create`. Add `remove-log-channel` to stop reports.
- `/autodelete show` shows a rule. Without `channel` it shows the rule of the channel you are in.
- `/autodelete list` lists the rules of this server.
- `/autodelete delete channel` deletes a rule with its tracked posts and cooldowns. It also deletes the rule's report webhook, unless another rule shares it.
