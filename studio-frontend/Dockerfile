# Runtime image for the Studio frontend.
# dist/ is built in CI (release.yml, frontend-dist job) before `docker build`.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/

EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
