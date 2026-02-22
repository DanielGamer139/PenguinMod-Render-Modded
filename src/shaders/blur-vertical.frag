precision mediump float;

varying vec2 v_texcoord;

uniform sampler2D u_texture;
uniform float u_texelSizeY;

void main() {
    vec4 c = vec4(0.0);

    // Gaussian weights (same as horizontal)
    c += texture2D(u_texture, v_texcoord + vec2(0.0, -2.0 * u_texelSizeY)) * 0.07027;
    c += texture2D(u_texture, v_texcoord + vec2(0.0, -1.0 * u_texelSizeY)) * 0.31621;
    c += texture2D(u_texture, v_texcoord) * 0.22702;
    c += texture2D(u_texture, v_texcoord + vec2(0.0,  1.0 * u_texelSizeY)) * 0.31621;
    c += texture2D(u_texture, v_texcoord + vec2(0.0,  2.0 * u_texelSizeY)) * 0.07027;

    gl_FragColor = c;
}
