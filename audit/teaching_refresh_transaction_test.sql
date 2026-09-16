-- Uses the source snapshot only inside the caller's rollback transaction.
do $$
declare c private.content_snapshots%rowtype; a private.content_snapshots%rowtype;
  vid text:='1789024924932'; job uuid; pub jsonb; draft jsonb; patches jsonb; result jsonb;
begin
  select * into c from private.content_snapshots where environment='production';
  select (v->>'processingJobId')::uuid into job from jsonb_array_elements(c.published->'videos') v where v->>'id'=vid;
  pub:=c.published->'sentences'->vid; draft:=c.draft->'sentences'->vid;
  select jsonb_agg(jsonb_build_object('id',r->>'id','keyWords','[]'::jsonb,'expressions','[]'::jsonb,
    'teachingAnalysis',jsonb_build_object('status','completed','promptVersion','rollback-test',
      'reviewVersion','rollback-test','sourceTextRevision',coalesce(r->'textRevision','1'::jsonb))) order by n)
    into patches from jsonb_array_elements(pub) with ordinality as x(r,n);
  if has_function_privilege('authenticated','public.service_commit_reviewed_teaching(text,uuid,bigint,jsonb,jsonb,jsonb)','EXECUTE')
    or has_function_privilege('anon','public.service_commit_reviewed_teaching(text,uuid,bigint,jsonb,jsonb,jsonb)','EXECUTE')
    then raise exception 'Teaching grant leaked'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform pg_temp.expect_failure(format('select public.service_commit_reviewed_teaching(%L,%L,%s,%L,%L,%L)',vid,job,c.revision,pub,draft,patches),'SERVICE_ROLE_REQUIRED');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform pg_temp.expect_failure(format('select public.service_commit_reviewed_teaching(%L,%L,%s,%L,%L,%L)',vid,job,c.revision-1,pub,draft,patches),'CONTENT_REVISION_CONFLICT');
  perform pg_temp.expect_failure(format('select public.service_commit_reviewed_teaching(%L,%L,%s,%L,%L,%L)',vid,job,c.revision,pub,draft-0,patches),'TEACHING_SOURCE_CHANGED');
  perform pg_temp.expect_failure(format('select public.service_commit_reviewed_teaching(%L,%L,%s,%L,%L,%L)',vid,job,c.revision,pub,draft,jsonb_set(patches,'{0,english}','"changed"')),'TEACHING_PATCH_FIELD_DENIED');
  perform pg_temp.expect_failure(format('select public.service_commit_reviewed_teaching(%L,%L,%s,%L,%L,%L)',vid,job,c.revision,pub,draft,jsonb_set(patches,'{0,teachingAnalysis,sourceTextRevision}','999')),'TEACHING_REVIEW_REQUIRED');
  perform pg_temp.expect_failure(format('select public.service_commit_reviewed_teaching(%L,%L,%s,%L,%L,%L)',vid,job,c.revision,pub,draft,jsonb_set(patches,'{0,id}','"wrong"')),'TEACHING_ROW_ID_CHANGED');
  result:=public.service_commit_reviewed_teaching(vid,job,c.revision,pub,draft,patches);
  select * into a from private.content_snapshots where environment='production';
  if a.revision<>c.revision+1 or a.published-'sentences'<>c.published-'sentences'
    or a.draft-'sentences'<>c.draft-'sentences' then raise exception 'Teaching changed catalog'; end if;
  if exists(select 1 from jsonb_array_elements(a.published->'sentences'->vid) r
    join jsonb_array_elements(pub) s on r->>'id'=s->>'id'
    where r-'keyWords'-'expressions'-'teachingAnalysis'<>s-'keyWords'-'expressions'-'teachingAnalysis')
    or exists(select 1 from jsonb_array_elements(a.draft->'sentences'->vid) r
    join jsonb_array_elements(draft) s on r->>'id'=s->>'id'
    where r-'keyWords'-'expressions'-'teachingAnalysis'<>s-'keyWords'-'expressions'-'teachingAnalysis')
    then raise exception 'Teaching changed editorial fields'; end if;
  if (a.published->'sentences')-vid<>(c.published->'sentences')-vid
    or (a.draft->'sentences')-vid<>(c.draft->'sentences')-vid then raise exception 'Teaching changed another video'; end if;
  if not exists(select 1 from private.catalog_field_backups where revision=c.revision and reason='teaching:'||vid)
    then raise exception 'Teaching backup missing'; end if;
end $$;
