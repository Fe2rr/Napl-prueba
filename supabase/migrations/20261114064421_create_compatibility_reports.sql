CREATE TABLE public.compatibility_reports (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    port_id text NOT NULL CHECK (length(port_id) BETWEEN 1 AND 120),
    token_hash text NOT NULL CHECK (length(token_hash) = 64),
    device_id text NOT NULL CHECK (length(device_id) BETWEEN 1 AND 200),
    device_name text NOT NULL CHECK (length(device_name) BETWEEN 1 AND 240),
    works boolean NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT compatibility_reports_voter_device_unique
        UNIQUE (port_id, token_hash, device_id)
);

CREATE INDEX compatibility_reports_port_updated_idx
    ON public.compatibility_reports (port_id, updated_at DESC, id DESC);

ALTER TABLE public.compatibility_reports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.compatibility_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.compatibility_reports TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.compatibility_reports_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.get_compatibility_for_ports(p_port_ids text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
    SELECT COALESCE(
        jsonb_object_agg(
            requested.port_id,
            jsonb_build_object(
                'yes', stats.yes_count,
                'no', stats.no_count,
                'reports', recent.reports
            )
        ),
        '{}'::jsonb
    )
    FROM (
        SELECT DISTINCT unnest(COALESCE(p_port_ids, ARRAY[]::text[])) AS port_id
    ) AS requested
    CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE works IS TRUE)::integer AS yes_count,
               count(*) FILTER (WHERE works IS FALSE)::integer AS no_count
        FROM public.compatibility_reports WHERE port_id = requested.port_id
    ) AS stats
    CROSS JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'deviceId', latest.device_id, 'deviceName', latest.device_name,
                'works', latest.works, 'updatedAt', latest.updated_at
            ) ORDER BY latest.updated_at DESC, latest.id DESC
        ), '[]'::jsonb) AS reports
        FROM (
            SELECT id, device_id, device_name, works, updated_at
            FROM public.compatibility_reports
            WHERE port_id = requested.port_id
            ORDER BY updated_at DESC, id DESC LIMIT 30
        ) AS latest
    ) AS recent;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_compatibility_report(
    p_port_id text, p_token_hash text, p_device_id text, p_device_name text, p_works boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE saved public.compatibility_reports%ROWTYPE;
BEGIN
    INSERT INTO public.compatibility_reports
        (port_id, token_hash, device_id, device_name, works, updated_at)
    VALUES (p_port_id, p_token_hash, p_device_id, p_device_name, p_works, now())
    ON CONFLICT (port_id, token_hash, device_id)
    DO UPDATE SET device_name = EXCLUDED.device_name,
                  works = EXCLUDED.works, updated_at = now()
    RETURNING * INTO saved;

    RETURN jsonb_build_object(
        'portId', saved.port_id, 'deviceId', saved.device_id,
        'deviceName', saved.device_name, 'works', saved.works,
        'updatedAt', saved.updated_at
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_compatibility_for_ports(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_compatibility_report(text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_compatibility_for_ports(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_compatibility_report(text, text, text, text, boolean) TO service_role;
