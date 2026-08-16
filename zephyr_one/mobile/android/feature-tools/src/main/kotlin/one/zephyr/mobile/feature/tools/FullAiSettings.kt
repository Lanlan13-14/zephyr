package one.zephyr.mobile.feature.tools

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.*
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.component.*
import one.zephyr.mobile.ui.theme.ZephyrMotionTokens
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme

private enum class AiSettingsPage { ROOT, PROVIDERS, PROVIDER_EDIT, MODELS, MODEL_EDIT, PERMISSIONS, MCP, ENV, MEMORIES, MEMORY_EDIT, SKILLS, SKILL_EDIT, SANDBOX }

@Composable
fun FullAiSettingsRoute(repository: LocalAiRepository, bound: Boolean, onBack: () -> Unit) {
    val catalog by repository.observe().collectAsState(initial = LocalAiCatalog())
    val scope = rememberCoroutineScope()
    var page by remember { mutableStateOf(AiSettingsPage.ROOT) }
    var providerDraft by remember { mutableStateOf(LocalAiProvider()) }
    var modelDraft by remember { mutableStateOf(LocalAiModel("")) }
    var memoryDraft by remember { mutableStateOf(LocalAiMemory()) }
    var skillDraft by remember { mutableStateOf(LocalAiSkill()) }
    var parentProviderId by remember { mutableStateOf("") }
    val goBack = { when (page) {
        AiSettingsPage.PROVIDER_EDIT, AiSettingsPage.MODELS -> page = AiSettingsPage.PROVIDERS
        AiSettingsPage.MODEL_EDIT -> page = AiSettingsPage.MODELS
        AiSettingsPage.MEMORY_EDIT -> page = AiSettingsPage.MEMORIES
        AiSettingsPage.SKILL_EDIT -> page = AiSettingsPage.SKILLS
        AiSettingsPage.ROOT -> onBack()
        else -> page = AiSettingsPage.ROOT
    } }
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = when(page){AiSettingsPage.ROOT->"AI 助理";AiSettingsPage.PROVIDERS->"模型供应商";AiSettingsPage.PROVIDER_EDIT->if(providerDraft.id.isBlank())"添加供应商" else "编辑供应商";AiSettingsPage.MODELS->"模型";AiSettingsPage.MODEL_EDIT->"模型详情";AiSettingsPage.PERMISSIONS->"工具与权限";AiSettingsPage.MCP->"MCP 服务器";AiSettingsPage.ENV->"AI 环境变量";AiSettingsPage.MEMORIES->"长期 Memory";AiSettingsPage.MEMORY_EDIT->"编辑 Memory";AiSettingsPage.SKILLS->"Skills 能力包";AiSettingsPage.SKILL_EDIT->"编辑 Skill";AiSettingsPage.SANDBOX->"本机沙箱"}, onBack = goBack)
        AnimatedContent(
            targetState = page,
            transitionSpec = {
                (slideInHorizontally(tween(220, easing = ZephyrMotionTokens.easeOut)) { it / 7 } + fadeIn(tween(160)))
                    .togetherWith(slideOutHorizontally(tween(180, easing = ZephyrMotionTokens.easeOut)) { -it / 10 } + fadeOut(tween(120)))
            }, label = "aiSettingsPage",
        ) { target -> when(target) {
            AiSettingsPage.ROOT -> AiRoot(catalog,bound,{ scope.launch { repository.save(it) } },{page=it})
            AiSettingsPage.PROVIDERS -> AiProviders(catalog,{providerDraft=it;page=AiSettingsPage.PROVIDER_EDIT},{parentProviderId=it.id;page=AiSettingsPage.MODELS},{scope.launch{repository.deleteProvider(it)}})
            AiSettingsPage.PROVIDER_EDIT -> ProviderEditor(providerDraft,{p,key->scope.launch{repository.upsertProvider(p,key);key?.fill('\u0000');page=AiSettingsPage.PROVIDERS}})
            AiSettingsPage.MODELS -> ModelList(catalog.providers.firstOrNull{it.id==parentProviderId},{modelDraft=it;page=AiSettingsPage.MODEL_EDIT})
            AiSettingsPage.MODEL_EDIT -> ModelEditor(modelDraft){m->scope.launch{val p=catalog.providers.first{it.id==parentProviderId};repository.upsertProvider(p.copy(models=p.models.filterNot{it.id==m.id}+m),null);page=AiSettingsPage.MODELS}}
            AiSettingsPage.PERMISSIONS -> PermissionEditor(catalog){scope.launch{repository.save(it)}}
            AiSettingsPage.MCP -> McpEditor(catalog,repository)
            AiSettingsPage.ENV -> EnvEditor(catalog,repository)
            AiSettingsPage.MEMORIES -> ResourceList(catalog.memories.map{it.id to it.title},"Memory",{memoryDraft=LocalAiMemory();page=AiSettingsPage.MEMORY_EDIT},{id->memoryDraft=catalog.memories.first{it.id==id};page=AiSettingsPage.MEMORY_EDIT},{scope.launch{repository.deleteMemory(it)}})
            AiSettingsPage.MEMORY_EDIT -> MemoryEditor(memoryDraft){scope.launch{repository.upsertMemory(it);page=AiSettingsPage.MEMORIES}}
            AiSettingsPage.SKILLS -> ResourceList(catalog.skills.map{it.id to it.name},"Skill",{skillDraft=LocalAiSkill();page=AiSettingsPage.SKILL_EDIT},{id->skillDraft=catalog.skills.first{it.id==id};page=AiSettingsPage.SKILL_EDIT},{scope.launch{repository.deleteSkill(it)}})
            AiSettingsPage.SKILL_EDIT -> SkillEditor(skillDraft){scope.launch{repository.upsertSkill(it);page=AiSettingsPage.SKILLS}}
            AiSettingsPage.SANDBOX -> SandboxEditor(catalog){scope.launch{repository.save(it)}}
        } }
    }
}

@Composable private fun AiRoot(c:LocalAiCatalog,bound:Boolean,save:(LocalAiCatalog)->Unit,open:(AiSettingsPage)->Unit){ AiScroll {
    Card { Toggle("启用 AI 助理","本机 Runtime、Provider 和数据不依赖主端",c.enabled){save(c.copy(enabled=it))}; Field("助理名称",c.assistantName){save(c.copy(assistantName=it))}; Field("系统提示词",c.systemPrompt,false,4){save(c.copy(systemPrompt=it))} }
    Section("本机 AI 平台"); Card {
        Nav("模型供应商","${c.providers.count{it.enabled}} 个启用",AiSettingsPage.PROVIDERS,open)
        Nav("工具与权限","Ask / Auto / Yolo + deny / ask / allow",AiSettingsPage.PERMISSIONS,open)
        Nav("MCP 服务器","${c.mcpServers.count{it.enabled}} 个启用",AiSettingsPage.MCP,open)
        Nav("AI 环境变量","${c.environment.size} 个；值存 Android Keystore",AiSettingsPage.ENV,open)
        Nav("长期 Memory","${c.memories.size} / ${c.memoryMaxItems}",AiSettingsPage.MEMORIES,open)
        Nav("Skills 能力包","${c.skills.count{it.enabled}} 个启用",AiSettingsPage.SKILLS,open)
        Nav("本机沙箱","L2 · ${if(c.sandbox.enabled)"启用" else "停用"} · 默认无网络",AiSettingsPage.SANDBOX,open,false)
    }
    Section("上下文与规划")
    Card {
        NumberField("上下文窗口 Tokens", c.context.windowTokens) {
            save(c.copy(context = c.context.copy(windowTokens = it)))
        }
        NumberField("最大输入字符数", c.context.maxInputChars) {
            save(c.copy(context = c.context.copy(maxInputChars = it)))
        }
        NumberField("工具结果注入字符数", c.context.toolResultChars) {
            save(c.copy(context = c.context.copy(toolResultChars = it)))
        }
        NumberField("工具调用轮次上限（0 无上限）", c.context.maxToolRounds) {
            save(c.copy(context = c.context.copy(maxToolRounds = it)))
        }
        Toggle("代码补全", null, c.codeCompletionEnabled) {
            save(c.copy(codeCompletionEnabled = it))
        }
        Toggle("任务规划器", null, c.planner.enabled) {
            save(c.copy(planner = c.planner.copy(enabled = it)))
        }
        Toggle("复杂任务先规划", null, c.planner.requirePlanBeforeTools) {
            save(c.copy(planner = c.planner.copy(requirePlanBeforeTools = it)))
        }
    }
    Section("可选同步"); Card { Toggle("从主端同步 AI 数据",if(bound)"可选增量来源；本机配置始终可编辑、可运行" else "绑定主端后可选；未绑定不影响任何 AI 功能",c.syncFromMainEnabled){save(c.copy(syncFromMainEnabled=it))} }
} }

@Composable private fun AiProviders(c:LocalAiCatalog,edit:(LocalAiProvider)->Unit,models:(LocalAiProvider)->Unit,delete:(String)->Unit){ AiScroll { PrimaryButton({edit(LocalAiProvider())},Modifier.fillMaxWidth()){Text("添加模型供应商")}; c.providers.forEach{p->Card{SettingsRow(p.name.ifBlank{"未命名"},subtitle="${p.type} · ${p.models.size} 模型 · ${p.source}",value=if(p.enabled)"启用" else "停用",showChevron=true,onClick={edit(p)});SettingsRow("模型列表",value="${p.models.size}",showChevron=true,onClick={models(p)});SettingsRow("删除供应商",titleColor=ZephyrTheme.palette.status.error,showDivider=false,onClick={delete(p.id)})}} } }

@Composable private fun ProviderEditor(initial:LocalAiProvider,save:(LocalAiProvider,CharArray?)->Unit){var d by remember(initial){mutableStateOf(initial)};var key by remember{mutableStateOf("")};AiScroll{Card{Field("名称",d.name){d=d.copy(name=it)};Choice("类型",d.type,listOf("openai-compatible","openai","anthropic","gemini","ollama")){d=d.copy(type=it)};Field("API Base URL",d.baseUrl){d=d.copy(baseUrl=it)};SecretField("API Key",key){key=it};Choice("接口模式",d.apiMode,listOf("auto","chat","responses")){d=d.copy(apiMode=it)};Field("默认模型",d.defaultModel){d=d.copy(defaultModel=it)};Field("Organization / Project",d.organization){d=d.copy(organization=it)};Field("额外请求头 JSON",d.extraHeadersJson,false,3){d=d.copy(extraHeadersJson=it)};Field("逐模型 User-Agent",d.modelUserAgents,false,3){d=d.copy(modelUserAgents=it)};NumberField("max_tokens",d.maxTokens){d=d.copy(maxTokens=it)};Field("供应商原生额外参数 JSON",d.extraJson,false,4){d=d.copy(extraJson=it)};Toggle("新模型默认支持图片",null,d.visionDefault){d=d.copy(visionDefault=it)};Toggle("Responses 使用 previous_response_id",null,d.usePreviousResponse){d=d.copy(usePreviousResponse=it)};Toggle("启用此供应商",null,d.enabled){d=d.copy(enabled=it)}};PrimaryButton({save(d,key.takeIf{it.isNotBlank()}?.toCharArray());key=""},Modifier.fillMaxWidth(),d.name.isNotBlank()){Text("保存供应商")}}}

@Composable private fun ModelList(p:LocalAiProvider?,edit:(LocalAiModel)->Unit){AiScroll{PrimaryButton({edit(LocalAiModel(""))},Modifier.fillMaxWidth()){Text("添加模型")};p?.models?.forEach{m->Card{SettingsRow(m.label,subtitle=m.id,value=buildString{if(m.reasoning)append("推理 ");if(m.inputImage)append("图片 ");if(m.inputPdf)append("PDF")}.trim(),showChevron=true,showDivider=false,onClick={edit(m)})}}}}
@Composable private fun ModelEditor(i:LocalAiModel,save:(LocalAiModel)->Unit){var d by remember(i){mutableStateOf(i)};AiScroll{Card{Field("模型 ID",d.id){d=d.copy(id=it)};Field("显示名称",d.label){d=d.copy(label=it)};NumberFieldNullable("上下文窗口",d.contextWindowTokens){d=d.copy(contextWindowTokens=it)};NumberFieldNullable("最大输出 Tokens",d.maxOutputTokens){d=d.copy(maxOutputTokens=it)};Toggle("扩展推理",null,d.reasoning){d=d.copy(reasoning=it)};Toggle("图片输入",null,d.inputImage){d=d.copy(inputImage=it)};Toggle("PDF 输入",null,d.inputPdf){d=d.copy(inputPdf=it)};Toggle("音频输入",null,d.inputAudio){d=d.copy(inputAudio=it)};Toggle("视频输入",null,d.inputVideo){d=d.copy(inputVideo=it)};Toggle("图片输出",null,d.outputImage){d=d.copy(outputImage=it)};Toggle("音频输出",null,d.outputAudio){d=d.copy(outputAudio=it)};Toggle("工具调用",null,d.tools){d=d.copy(tools=it)};Toggle("并行工具调用",null,d.parallelToolCalls){d=d.copy(parallelToolCalls=it)};Toggle("隐藏模型",null,d.hidden){d=d.copy(hidden=it)}};PrimaryButton({save(d.copy(label=d.label.ifBlank{d.id}))},Modifier.fillMaxWidth(),d.id.isNotBlank()){Text("保存模型能力")}}}

@Composable private fun PermissionEditor(c:LocalAiCatalog,save:(LocalAiCatalog)->Unit){var x by remember(c){mutableStateOf(c)};AiScroll{Card{Choice("默认模式",x.permissionRules.mode,listOf("ask","auto","yolo")){x=x.copy(permissionRules=x.permissionRules.copy(mode=it));save(x)};Lines("Deny（永久拒绝）",x.permissionRules.deny){x=x.copy(permissionRules=x.permissionRules.copy(deny=it));save(x)};Lines("Allow（永不询问）",x.permissionRules.allow){x=x.copy(permissionRules=x.permissionRules.copy(allow=it));save(x)};Lines("Ask（强制询问）",x.permissionRules.ask){x=x.copy(permissionRules=x.permissionRules.copy(ask=it));save(x)}};Section("工具目录");Card{Perm("网页搜索",x.permissions.webSearch){x=x.copy(permissions=x.permissions.copy(webSearch=it));save(x)};Perm("网页正文读取",x.permissions.webFetch){x=x.copy(permissions=x.permissions.copy(webFetch=it));save(x)};Perm("浏览器自动化",x.permissions.browser){x=x.copy(permissions=x.permissions.copy(browser=it));save(x)};Perm("远程命令执行",x.permissions.remoteExecute){x=x.copy(permissions=x.permissions.copy(remoteExecute=it));save(x)};Perm("远程文件读取",x.permissions.fileRead){x=x.copy(permissions=x.permissions.copy(fileRead=it));save(x)};Perm("远程文件写入",x.permissions.fileWrite){x=x.copy(permissions=x.permissions.copy(fileWrite=it));save(x)};Perm("代码编辑/补全",x.permissions.codeEdit){x=x.copy(permissions=x.permissions.copy(codeEdit=it));save(x)};Perm("Memory",x.permissions.memory){x=x.copy(permissions=x.permissions.copy(memory=it));save(x)};Perm("读取笔记",x.permissions.notesRead){x=x.copy(permissions=x.permissions.copy(notesRead=it));save(x)};Perm("修改笔记",x.permissions.notesWrite){x=x.copy(permissions=x.permissions.copy(notesWrite=it));save(x)};Perm("环境变量",x.permissions.env){x=x.copy(permissions=x.permissions.copy(env=it));save(x)};Perm("本机沙箱",x.permissions.sandbox){x=x.copy(permissions=x.permissions.copy(sandbox=it));save(x)}};Section("敏感操作");Card{Toggle("敏感操作需要确认",null,x.sensitive.requireConfirmation){x=x.copy(sensitive=x.sensitive.copy(requireConfirmation=it));save(x)};Toggle("自动确认敏感操作","危险：仅在你明确接受风险时启用",x.sensitive.autoConfirm){x=x.copy(sensitive=x.sensitive.copy(autoConfirm=it));save(x)};NumberField("自动确认延迟 ms",x.sensitive.autoConfirmDelayMs){x=x.copy(sensitive=x.sensitive.copy(autoConfirmDelayMs=it.coerceIn(0,60000)));save(x)}}}}

@Composable private fun McpEditor(c:LocalAiCatalog,r:LocalAiRepository){val scope=rememberCoroutineScope();var d by remember{mutableStateOf(LocalAiMcpServer())};var headers by remember{mutableStateOf("")};AiScroll{Card{Field("名称",d.name){d=d.copy(name=it)};Choice("传输",d.type,listOf("http","stdio")){d=d.copy(type=it)};if(d.type=="http"){Field("URL",d.url){d=d.copy(url=it)};SecretField("Headers（Header: value 每行）",headers){headers=it}}else{Field("命令",d.command){d=d.copy(command=it)};Field("参数（空格分隔）",d.args.joinToString(" ")){d=d.copy(args=it.split(' ').filter(String::isNotBlank))}};Field("信任为只读的工具名",d.trustedReadOnly.joinToString(",")){d=d.copy(trustedReadOnly=csv(it))};NumberField("调用超时（秒）",d.timeoutSeconds){d=d.copy(timeoutSeconds=it.coerceIn(1,7200))};Toggle("启用 MCP",null,d.enabled){d=d.copy(enabled=it)};PrimaryButton({scope.launch{r.upsertMcp(d,headers.takeIf{it.isNotBlank()}?.toCharArray());headers="";d=LocalAiMcpServer()}},Modifier.fillMaxWidth(),d.name.isNotBlank()){Text("保存 MCP")}};c.mcpServers.forEach{s->Card{SettingsRow(s.name,subtitle="${s.type} · ${if(s.enabled)"启用" else "停用"}",showChevron=true,onClick={d=s});SettingsRow("删除",titleColor=ZephyrTheme.palette.status.error,showDivider=false,onClick={scope.launch{r.deleteMcp(s.id)}})}}}}
@Composable private fun EnvEditor(c:LocalAiCatalog,r:LocalAiRepository){val scope=rememberCoroutineScope();var d by remember{mutableStateOf(LocalAiEnvironment())};var value by remember{mutableStateOf("")};AiScroll{Card{Field("变量名",d.name){d=d.copy(name=it.uppercase())};Field("说明",d.description){d=d.copy(description=it)};SecretField("变量值",value){value=it};Toggle("启用变量",null,d.enabled){d=d.copy(enabled=it)};Toggle("AI 可见变量名/说明",null,d.visibleToAi){d=d.copy(visibleToAi=it)};Toggle("AI 可直接看到值","仅用于非敏感配置",d.valueVisibleToAi){d=d.copy(valueVisibleToAi=it)};PrimaryButton({scope.launch{r.upsertEnvironment(d,value.takeIf{it.isNotBlank()}?.toCharArray());value="";d=LocalAiEnvironment()}},Modifier.fillMaxWidth(),d.name.matches(Regex("[A-Z_][A-Z0-9_]*"))){Text("保存环境变量")}};c.environment.forEach{e->Card{SettingsRow(e.name,subtitle=e.description,value=if(e.enabled)"启用" else "停用",showChevron=true,onClick={d=e});SettingsRow("删除",titleColor=ZephyrTheme.palette.status.error,showDivider=false,onClick={scope.launch{r.deleteEnvironment(e.id)}})}}}}
@Composable private fun ResourceList(items:List<Pair<String,String>>,label:String,add:()->Unit,edit:(String)->Unit,delete:(String)->Unit){AiScroll{PrimaryButton(add,Modifier.fillMaxWidth()){Text("添加 $label")};items.forEach{(id,name)->Card{SettingsRow(name.ifBlank{"未命名 $label"},showChevron=true,onClick={edit(id)});SettingsRow("删除",titleColor=ZephyrTheme.palette.status.error,showDivider=false,onClick={delete(id)})}}}}
@Composable private fun MemoryEditor(i:LocalAiMemory,save:(LocalAiMemory)->Unit){var d by remember(i){mutableStateOf(i)};AiScroll{Card{Field("标题",d.title){d=d.copy(title=it)};Field("Scope",d.scope){d=d.copy(scope=it)};Field("Project",d.project){d=d.copy(project=it)};Field("关联连接 ID",d.connectionIds.joinToString(",")){d=d.copy(connectionIds=csv(it))};Field("标签",d.tags.joinToString(",")){d=d.copy(tags=csv(it))};Field("内容",d.content,false,7){d=d.copy(content=it)};Toggle("启用此 Memory",null,d.enabled){d=d.copy(enabled=it)}};PrimaryButton({save(d)},Modifier.fillMaxWidth(),d.title.isNotBlank()&&d.content.isNotBlank()){Text("保存 Memory")}}}
@Composable private fun SkillEditor(i:LocalAiSkill,save:(LocalAiSkill)->Unit){var d by remember(i){mutableStateOf(i)};AiScroll{Card{Field("Skill 名称",d.name){d=d.copy(name=it)};Field("说明",d.description){d=d.copy(description=it)};Field("Skill 指令",d.prompt,false,9){d=d.copy(prompt=it)};Toggle("启用 Skill",null,d.enabled){d=d.copy(enabled=it)}};PrimaryButton({save(d)},Modifier.fillMaxWidth(),d.name.isNotBlank()&&d.prompt.isNotBlank()){Text("保存 Skill")}}}
@Composable private fun SandboxEditor(c:LocalAiCatalog,save:(LocalAiCatalog)->Unit){var x by remember(c){mutableStateOf(c)};AiScroll{Card{Toggle("启用本机沙箱","会话隔离目录 · 无 shell · 命令白名单 · 审计",x.sandbox.enabled){x=x.copy(sandbox=x.sandbox.copy(enabled=it));save(x)};NumberField("工作区配额 MB",x.sandbox.workspaceQuotaMb){x=x.copy(sandbox=x.sandbox.copy(workspaceQuotaMb=it.coerceIn(32,2048)));save(x)};NumberField("命令超时秒",x.sandbox.timeoutSeconds){x=x.copy(sandbox=x.sandbox.copy(timeoutSeconds=it.coerceIn(1,300)));save(x)};Toggle("默认允许网络","Android 沙箱强制关闭；需要网络请使用网页/MCP 工具",false){};Lines("允许命令",x.sandbox.allowedCommands){x=x.copy(sandbox=x.sandbox.copy(allowedCommands=it));save(x)}};Text("内置文本工具可直接运行；Python / Node / Go / Rust / FFmpeg 当前 APK 未打包时会明确报告 not-packaged，不会伪装成功。",color=ZephyrTheme.palette.onFloatingMuted,fontSize=12.sp)}}

@Composable private fun AiScroll(content:@Composable androidx.compose.foundation.layout.ColumnScope.()->Unit){Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal=ZephyrSpacing.lg,vertical=8.dp).padding(bottom=140.dp),verticalArrangement=Arrangement.spacedBy(12.dp),content=content)}
@Composable private fun Card(content:@Composable androidx.compose.foundation.layout.ColumnScope.()->Unit)=GroupCard(content=content)
@Composable private fun Section(s:String)=one.zephyr.mobile.ui.component.SectionLabel(s)
@Composable private fun Nav(t:String,s:String,p:AiSettingsPage,o:(AiSettingsPage)->Unit,d:Boolean=true)=SettingsRow(t,subtitle=s,showChevron=true,showDivider=d,onClick={o(p)})
@Composable private fun Toggle(t:String,s:String?,v:Boolean,set:(Boolean)->Unit)=SettingsRow(t,subtitle=s,trailing={Switch(v,set)})
@Composable private fun Perm(t:String,v:Boolean,set:(Boolean)->Unit)=Toggle(t,null,v,set)
@Composable private fun Field(label:String,value:String,single:Boolean=true,lines:Int=1,set:(String)->Unit){Column(Modifier.padding(horizontal=14.dp,vertical=8.dp)){Text(label,fontSize=12.sp,color=ZephyrTheme.palette.onFloatingMuted);OutlinedTextField(value,set,Modifier.fillMaxWidth(),singleLine=single,minLines=lines,maxLines=lines)}}
@Composable private fun SecretField(label:String,value:String,set:(String)->Unit)=Column(Modifier.padding(horizontal=14.dp,vertical=8.dp)){Text(label,fontSize=12.sp,color=ZephyrTheme.palette.onFloatingMuted);OutlinedTextField(value,set,Modifier.fillMaxWidth(),visualTransformation=PasswordVisualTransformation(),singleLine=true,placeholder={Text("留空保持原值")})}
@Composable private fun NumberField(label:String,v:Int,set:(Int)->Unit)=Field(label,"$v"){it.toIntOrNull()?.let(set)}
@Composable private fun NumberFieldNullable(label:String,v:Int?,set:(Int?)->Unit)=Field(label,v?.toString().orEmpty()){set(it.toIntOrNull())}
@Composable private fun Lines(label:String,v:List<String>,set:(List<String>)->Unit)=Field(label,v.joinToString("\n"),false,4){set(it.lineSequence().map(String::trim).filter(String::isNotEmpty).toList())}
@Composable private fun Choice(label:String,v:String,options:List<String>,set:(String)->Unit){var open by remember{mutableStateOf(false)};SettingsRow(label,value=v,showChevron=true,onClick={open=true});ActionSheet(visible=open,onDismiss={open=false},groups=listOf(ActionSheetGroup(items=options.map{option->ActionSheetItem(label=option,onClick={set(option)})})))}
private fun csv(s:String)=s.split(',','\n').map(String::trim).filter(String::isNotEmpty).distinct()
