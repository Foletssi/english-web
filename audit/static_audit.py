from pathlib import Path
from html.parser import HTMLParser
import json, subprocess, re, sys
root=Path(__file__).resolve().parents[1]
checks=[]
def add(name,ok,detail=''):
    checks.append({'name':name,'ok':bool(ok),'detail':detail})
class P(HTMLParser):
    def __init__(self): super().__init__(); self.ids=[]; self.refs=[]
    def handle_starttag(self,tag,attrs):
        d=dict(attrs)
        if 'id' in d:self.ids.append(d['id'])
        if tag=='script' and d.get('src'):self.refs.append(d['src'])
        if tag=='link' and d.get('href'):self.refs.append(d['href'])
for rel in ['index.html','login.html','admin/index.html','admin/login.html']:
    p=P();p.feed((root/rel).read_text(encoding='utf-8'))
    dup=sorted({x for x in p.ids if p.ids.count(x)>1})
    add(f'{rel}: unique DOM ids',not dup,','.join(dup))
    missing=[]
    base=(root/rel).parent
    for ref in p.refs:
        if ref.startswith(('http:','https:','#','data:')):continue
        target=(base/ref.split('?')[0]).resolve()
        if not target.exists():missing.append(ref)
    add(f'{rel}: local script/css refs exist',not missing,','.join(missing))
for rel in ['assets/js/app.js','admin/assets/admin.js','admin/assets/admin-login.js','shared/content-store.js','shared/supabase-client.js','shared/admin-auth.js']:
    r=subprocess.run(['node','--check',str(root/rel)],capture_output=True,text=True)
    add(f'{rel}: JavaScript syntax',r.returncode==0,(r.stderr or '').strip())
student=(root/'index.html').read_text(encoding='utf-8')
app=(root/'assets/js/app.js').read_text(encoding='utf-8')
admin=(root/'admin/assets/admin.js').read_text(encoding='utf-8')
student_css=(root/'assets/css/app.css').read_text(encoding='utf-8')
admin_css=(root/'admin/assets/admin.css').read_text(encoding='utf-8')
add('student loads shared content contract','shared/content-store.js' in student)
add('student hydrates managed published content','hydrateManagedContent()' in app and 'publishedOnly:true' in app)
add('student resolves active video id dynamically','function activeVideoId()' in app and "progress:'+id" in app)
add('admin can CRUD video records',all(x in admin for x in ['saveVideo','setVideoStatus','openVideoModal']))
add('admin exposes pipeline boundary',all(x in admin for x in ['startPipeline','advancePipeline','renderPipeline']))
add('admin exposes subtitle editor',all(x in admin for x in ['renderSubtitleEditor','saveSentence']))
add('admin/student same-origin link exists','../index.html#/home' in (root/'admin/index.html').read_text(encoding='utf-8'))
add('student account menu exposes logout/profile/preferences',all(x in student for x in ['data-account-action="logout"','data-account-action="profile"','data-account-action="preferences"']))
add('student account menu has executable session behavior',all(x in app for x in ['function bindAccountUI()','function performLogout()','signinBackdrop']))
login=(root/'login.html').read_text(encoding='utf-8')
login_js=(root/'assets/js/student-login.js').read_text(encoding='utf-8')
add('student uses phone/password Supabase authentication',all(x in login for x in ['studentPhone','data-login-method','shared/supabase-client.js']) and all(x in login_js for x in ['signInPhone','signUpPhone','role !== \'student\'']))
add('student has a dedicated connected login page',(root/'login.html').exists() and (root/'assets/js/student-login.js').exists() and all(x in login for x in ['student-login-form','data-auth-mode','shared/supabase-client.js']) and all(x in login_js for x in ['signInPhone(','signUpPhone(']))
add('student page does not expose admin login link','signin-admin-entry' not in student and '管理人员从这里登录' not in student)
add('student and admin sessions are isolated',all(x in (root/'shared/supabase-client.js').read_text(encoding='utf-8') for x in ["scope === 'admin'","'eastudy-' + key + '-auth'","storageKey"]))
add('admin has a separate guarded login entry',(root/'admin/login.html').exists() and all(x in (root/'admin/index.html').read_text(encoding='utf-8') for x in ['admin-auth.js','admin-auth-pending']) and 'EastudyAdminGate' in admin)
add('Supabase migration protects learner data with RLS',(root/'supabase/migrations/20260907_mvp_auth_and_learning.sql').exists() and all(x in (root/'supabase/migrations/20260907_mvp_auth_and_learning.sql').read_text(encoding='utf-8') for x in ['enable row level security','user_vocabulary','study_events','auth.uid()']))
add('student preferences dialog is viewport-centered',all(x in student_css for x in ['.backdrop.show{display:grid!important}','right:auto!important','place-items:center']))
add('student streak uses redesigned weekly rhythm UI','streak-v3' in student and '.streak-v3-days' in student_css)
add('admin typography meets readability floor',all(x in admin_css for x in ['.side-nav a{height:44px;font-size:14px','.data-table td{padding:12px 14px;font-size:12px','.page-head p{font-size:14px']))

add('student exposes key-word cloze mode',all(x in student for x in ['data-mode="cloze"','data-mode="english"']) and all(x in app for x in ['function clozeSentenceHTML','function checkClozeEntry','function sentenceKeywords']))
add('mobile study page uses continuous sentence flow',all(x in student_css for x in ['.mobile-study-tabs{display:none!important}','order:4;display:block!important','.desktop-vocab-mode{display:none!important}']))
add('admin authors per-sentence keyWords',all(x in admin for x in ['keyword-editor','data-field="keyWords"',"keyWords:input('keyWords')"]))
add('shared Sentence Contract exposes word-level timings',all(x in (root/'shared/content-store.js').read_text(encoding='utf-8') for x in ['wordTimings','deriveWordTimings','INVALID_WORD_TIMING']))
add('student synchronizes spoken word highlight',all(x in app for x in ['data-word-start','function updateWordTimeline','timing-active']))
add('admin authors word-level timings',all(x in admin for x in ['data-field="wordTimings"','parseWordTimeline','word-timeline-editor']))
add('admin theme is independent from learner theme',all(x in admin for x in ['ADMIN_THEME_KEY',"zs:admin:theme"]) and 'zs:admin:theme' in (root/'admin/index.html').read_text(encoding='utf-8'))
add('subtitle review offers automatic alignment before advanced timing edits',all(x in admin for x in ['timeline-summary','data-auto-timeline','timeline-advanced']))
add('admin offers AI connection configuration guidance',(root/'README_AI_CONFIGURATION.md').exists() and (root/'.env.example').exists() and 'aiConfigForm' in admin)
add('admin pipeline performs sentence-aware learning analysis',all(x in admin for x in ['data-analyze-learning','analyzeVideoLearningFields','analyzeSentenceLearningFields','learning_analysis']))
add('admin upload captures bilingual title and learning-analysis option',all(x in (root/'admin/index.html').read_text(encoding='utf-8') for x in ['name="titleZh"','name="doLearningAnalysis"']))
add('student switches active video title by interface language',all(x in app for x in ['function localizedVideoTitle','function syncStudyVideoTitle','video.titleZh||video.title']) and 'data-no-ui-translate' in student)
add('learner insight renders every authored key expression',"sentenceKeywords(d).slice(0,3)" in app and "join('；')" in app)
add('learner typography uses readable 16px support copy',all(x in student_css for x in ['--eastudy-body:19px','.video-page .insight-grid p{font-size:16px!important','.collection-video-info h3{font-size:21px!important']))
add('official Eastudy logo asset is used on every brand surface',all(x in student for x in ['eastudy-logo--top','eastudy-logo--mobile','eastudy-logo--sidebar','eastudy-icon.png']) and 'eastudy-logo.png' in login and all(x in (root/'admin/index.html').read_text(encoding='utf-8') for x in ['eastudy-logo--studio','eastudy-icon.png']) and (root/'assets/images/eastudy-logo.png').exists() and (root/'assets/images/eastudy-icon.png').exists())
add('supplied VIP artwork is used on all membership surfaces',all((root/'assets/images'/name).exists() for name in ['eastudy-vip-dark.png','eastudy-vip-light.png']) and all(x in student_css for x in ["--eastudy-vip-logo:url('../images/eastudy-vip-light.png')","--eastudy-vip-logo:url('../images/eastudy-vip-dark.png')",'.vip-badge,','.vip-emblem,']))
add('homepage upgrade promotion card is removed','home-pro-card' not in student and '升级至 Eastudy Pro' not in student)
add('supplied motivation card switches with learner theme',all((root/'assets/images'/name).exists() for name in ['eastudy-quote-light.webp','eastudy-quote-dark.webp']) and all(x in student_css for x in ["--eastudy-quote-art:url('../images/eastudy-quote-light.webp')","--eastudy-quote-art:url('../images/eastudy-quote-dark.webp')",'aspect-ratio:var(--eastudy-quote-ratio)']))
add('desktop study workspace has no page or left-pane scrolling',all(x in student_css for x in ['@media(min-width:851px)','height:calc(100vh - 58px)!important','overflow:hidden!important','only subtitles scroll']))
add('adjacent key expressions receive distinct colour tones',all(x in app for x in ["keywordTone=(keywordTone%4)+1","cls.push('keyword-tone-'+keywordTone)"]) and all(f'keyword-tone-{i}' in student_css for i in range(1,5)))
add('vocabulary state persists across reloads',all(x in app for x in ["Storage.get('vocabMeta'","Storage.set('vocabMeta'",'nextReviewAt','correctStreak']))
add('vocabulary review flow reveals then grades recall',all(x in student for x in ['vocabReviewPanel','vocabReviewReveal','vocabReviewAgain','vocabReviewKnown']) and all(x in app for x in ['openVocabReview','revealVocabReview','gradeVocabReview']))
add('vocabulary statistics are data driven',all(x in student for x in ['vocabWeeklyCount','vocabDueCount','vocabMasteryRate']) and 'function updateVocabStats' in app)
add('web deployment preserves isolated admin pages',(root/'README_WEB_DEPLOY.md').exists() and (root/'admin/login.html').exists() and (root/'admin/index.html').exists() and '/admin /admin/login.html 200' not in (root/'_redirects').read_text(encoding='utf-8'))
run=subprocess.run(['node',str(root/'audit/runtime_contract_test.mjs')],capture_output=True,text=True)
add('runtime shared-contract regression',run.returncode==0,(run.stdout+run.stderr).strip())
report={'ok':all(c['ok'] for c in checks),'passed':sum(c['ok'] for c in checks),'total':len(checks),'checks':checks}
(root/'audit/AUDIT_REPORT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
md=['# Eastudy Composite V1 Beta 6.20 — Audit Report','',f"Result: **{'PASS' if report['ok'] else 'FAIL'}**  ({report['passed']}/{report['total']})",'']
for c in checks:md.append(f"- {'PASS' if c['ok'] else 'FAIL'} — {c['name']}"+(f" — {c['detail']}" if c['detail'] else ''))
(root/'audit/AUDIT_REPORT.md').write_text('\n'.join(md)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
sys.exit(0 if report['ok'] else 1)
