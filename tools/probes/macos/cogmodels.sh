#!/bin/bash
data="$HOME/Library/Application Support/Cogitator"
[ -d "$data" ] || exit 0
start=$SECONDS
count=0
partial=0
seen=$'\n'
filtered=''
if [ -f "$data/cogitator.toml" ]; then
    filtered=$(awk '
    function clean(s,    i,c,q,e,out) {
        q=""; e=0; out=""
        for(i=1;i<=length(s);i++) {
            c=substr(s,i,1)
            if(e) e=0
            else if(q=="\042" && c=="\\") e=1
            else if(q!="") { if(c==q) q="" }
            else if(c=="\042" || c=="\047") q=c
            else if(c=="#") break
            out=out c
        }
        sub(/^[ \t]+/,"",out); sub(/[ \t\r]+$/,"",out); return out
    }
    function tokens(s,    i,c,q,e,n,v,r) {
        n=0; q=""; e=0; v=""; r=""
        for(i=1;i<=length(s);i++) {
            c=substr(s,i,1)
            if(q=="") { if(c=="\042" || c=="\047") { q=c; v=""; r=c } }
            else {
                r=r c
                if(e) { if(c=="n" || c=="r" || c=="t") v=v "\t"; else v=v c; e=0 }
                else if(q=="\042" && c=="\\") e=1
                else if(c==q) { n++; val[n]=v; raw[n]=r; q="" }
                else v=v c
            }
        }
        return n
    }
    function root(v) { if(v!~/\$\{/ && v!~/[\t\r\n]/) print "---SCOUT-ROOT\t" v }
    function field(k,v,    n,i,out,sep) {
        if(!((section=="[[engines]]" && (k=="id" || k=="args")) || (section=="[[roles]]" && (k=="name" || k=="chain")) || (section=="[media]" && (k=="model_dirs" || k=="store_dir")))) return
        n=tokens(v); out=""; sep=""
        for(i=1;i<=n;i++) {
            if(k=="args") {
                if((val[i]=="-m" || val[i]=="--model" || val[i]=="--mmproj") && i<n && val[i+1]!~/\$\{/) {
                    out=out sep raw[i] ", " raw[i+1]; sep=", "; i++; root(val[i])
                } else if(val[i]=="--embeddings") { out=out sep raw[i]; sep=", " }
            } else if(k!="chain" || val[i]!~/@/) { out=out sep raw[i]; sep=", " }
            if(section=="[media]") root(val[i])
        }
        if(v~/^\[/) print k " = [" out "]"; else if(out!="") print k " = " out
    }
    {
        s=clean($0)
        if(s~/^\[.+\]$/) { section=s; pending=""; if(section=="[[engines]]" || section=="[[roles]]" || section=="[media]") print s; next }
        if(pending!="") { value=value " " s; if(s~/\]$/) { field(pending,value); pending="" }; next }
        if(s~/^[a-zA-Z_]+[ \t]*=/) {
            k=s; sub(/[ \t]*=.*/,"",k); v=s; sub(/^[^=]*=[ \t]*/,"",v)
            if(v~/^\[/ && v!~/\]$/) { pending=k; value=v } else field(k,v)
        }
    }' "$data/cogitator.toml")
fi
printf '%s\n' '---SCOUT-CONFIG---'
printf '%s\n' "$filtered" | awk '!/^---SCOUT-ROOT\t/'
expired() { [ $((SECONDS-start)) -ge 20 ] || [ "$count" -ge 2000 ]; }
metadata() {
    [ -f "$1" ] || return 0
    [ ! -L "$1" ] || return 0
    if expired; then partial=1; return; fi
    local size
    size=$(stat -c %s -- "$1" 2>/dev/null) || size=$(stat -f %z "$1" 2>/dev/null) || { partial=1; return; }
    if [ "$size" -gt 2097152 ]; then partial=1; return; fi
    printf '%s\n' "---SCOUT-META $1---"
    cat -- "$1" || partial=1
    printf '\n%s\n' '---SCOUT-END---'
}
metadata "$data/models/lock.json"
metadata "$data/catalog.local.toml"
metadata "$data/data/catalog.local.toml"
walk() {
    if expired; then partial=1; return; fi
    local path="$1" depth="$2" child ext stats size epoch modified stem folder
    if command -v cygpath >/dev/null 2>&1; then path=$(cygpath -u "$path"); fi
    case "$path" in '~/'*) path="$HOME/${path:2}" ;; esac
    [ -e "$path" ] || return 0
    [ ! -L "$path" ] || return 0
    case "$path" in /*) ;; *) path="$PWD/$path" ;; esac
    case "$seen" in *$'\n'"$path"$'\n'*) return ;; esac
    seen="$seen$path"$'\n'
    if [ -d "$path" ]; then
        folder=0
        if [ -f "$path/config.json" ]; then
            for child in "$path"/*.safetensors; do [ -f "$child" ] && folder=1; done
        fi
        if [ "$folder" -eq 1 ]; then
            epoch=$(stat -c %Y -- "$path" 2>/dev/null) || epoch=$(stat -f %m "$path" 2>/dev/null)
            modified=$(date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null) || modified=$(date -u -r "$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)
            if [ -n "$modified" ]; then printf '%s\n%s\t%s\n' '---SCOUT-FOLDER---' "$path" "$modified"; else partial=1; fi
        fi
        for child in "$path"/* "$path"/.[!.]*; do
            [ -e "$child" ] || continue
            if expired; then partial=1; break; fi
            case "$child" in "$data/data/models/"*/lock.json|"$data/data/models/lock.json") metadata "$child" ;; esac
            if [ -d "$child" ]; then [ "$depth" -gt 0 ] && walk "$child" "$((depth-1))"
            else walk "$child" "$depth"; fi
        done
        return 0
    fi
    ext="${path##*.}"
    case "$ext" in gguf|GGUF|safetensors|ckpt|pt|pth|bin|onnx|mlmodel|npz) ;; *) return 0 ;; esac
    if [ "$ext" = gguf ] || [ "$ext" = GGUF ]; then
        if [ "$(head -c 4 -- "$path" 2>/dev/null)" != GGUF ]; then partial=1; return; fi
    fi
    stats=$(stat -c '%s %Y' -- "$path" 2>/dev/null) || stats=$(stat -f '%z %m' "$path" 2>/dev/null) || { partial=1; return; }
    size=${stats%% *}; epoch=${stats##* }
    modified=$(date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null) || modified=$(date -u -r "$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null) || { partial=1; return; }
    count=$((count+1))
    printf '%s\n%s\t%s\t%s\n' '---SCOUT-FILE---' "$path" "$size" "$modified"
    stem=${path%.*}
    metadata "$stem.cm-info.json"
    metadata "$stem.cogitator.json"
}
walk "$data/models" 4
walk "$data/data/models" 4
while IFS= read -r root; do
    [ -n "$root" ] && walk "$root" 4
done < <(printf '%s\n' "$filtered" | awk '/^---SCOUT-ROOT\t/ {sub(/^---SCOUT-ROOT\t/, ""); print}')
[ "$partial" -eq 0 ] || printf '%s\n' '---SCOUT-PARTIAL---'
printf '%s\n' '---SCOUT-DONE---'
