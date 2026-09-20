-- Run in a caller-owned transaction after the read-I/O migration; ROLLBACK.
-- The large payload exists only in a temporary table. No video/job is updated.
do $test$
declare actual jsonb;
begin
 select jsonb_agg(value) into actual from private.processing_video_headers_v1(
  '[{"id":1,"title":"first","voiceManifest":{"private":"large"}},{"id":2,"custom":{"keep":true}},{"id":2,"voiceManifest":null}]') value;
 if actual is distinct from '[{"id":1,"title":"first"},{"id":2,"custom":{"keep":true}},{"id":2}]'::jsonb then
  raise exception 'HEADER_ORDER_FIELDS_OR_DUPLICATES_CHANGED'; end if;
 if exists(select 1 from private.processing_video_headers_v1(null)) or exists(select 1 from private.processing_video_headers_v1('[]')) then
  raise exception 'EMPTY_HEADERS_NOT_EMPTY'; end if;
 if has_function_privilege('anon','private.processing_video_headers_v1(jsonb)','EXECUTE')
   or has_function_privilege('authenticated','private.processing_video_headers_v1(jsonb)','EXECUTE')
   or has_function_privilege('service_role','private.processing_video_headers_v1(jsonb)','EXECUTE') then
  raise exception 'PRIVATE_PROJECTION_EXPOSED'; end if;
end $test$;

create temporary table io_payload on commit drop as
 select jsonb_agg(jsonb_build_object('id',i,'title','synthetic video','voiceManifest',
  jsonb_build_object('items',repeat('x',1048576)))) as videos from generate_series(1,8) i;
create temporary table io_benchmark(name text,ms numeric,temp_read_blocks bigint,temp_written_blocks bigint) on commit drop;
do $test$
declare plan jsonb; original_blocks bigint; revised_blocks bigint;
begin
 execute $query$explain(analyze,buffers,format json)
  select count(*) from pg_temp.io_payload p cross join lateral jsonb_array_elements(p.videos) v where v->>'id'='8'$query$ into plan;
 original_blocks:=coalesce((plan#>>'{0,Plan,Temp Written Blocks}')::bigint,0);
 insert into io_benchmark values('original raw video expansion',(plan#>>'{0,Execution Time}')::numeric,
  coalesce((plan#>>'{0,Plan,Temp Read Blocks}')::bigint,0),original_blocks);
 execute $query$explain(analyze,buffers,format json)
  select count(*) from pg_temp.io_payload p cross join lateral private.processing_video_headers_v1(p.videos) v where v->>'id'='8'$query$ into plan;
 revised_blocks:=coalesce((plan#>>'{0,Plan,Temp Written Blocks}')::bigint,0);
 insert into io_benchmark values('project before row materialization',(plan#>>'{0,Execution Time}')::numeric,
  coalesce((plan#>>'{0,Plan,Temp Read Blocks}')::bigint,0),revised_blocks);
 if original_blocks<100 or revised_blocks<>0 then raise exception 'IO_REGRESSION: original %, revised %',original_blocks,revised_blocks; end if;
end $test$;
