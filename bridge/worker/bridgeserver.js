/*
 * Copyright (C) 2014 Ericsson AB. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer
 *    in the documentation and/or other materials provided with the
 *    distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

"use strict";

var imageServers = {};
var imageServerBasePort = 10000 + Math.floor(Math.random() * 40000);
var nextImageServerPort = imageServerBasePort;

var connections = [];

var server = new WebSocketServer(10717, "127.0.0.1");
server.onaccept = function (event) {
    var ws = event.socket;
    var origin = event.origin;
    var channel = {
        "postMessage": function (message) {
            ws.send(message);
        },
        "onmessage": null
    };

    ws.onmessage = function (event) {
        if (channel.onmessage)
            channel.onmessage(event);
    };

    var rpcScope = {};
    var jsonRpc = new JsonRpc(channel, {"scope": rpcScope, "noRemoteExceptions": true});
    var connection = {
        "origin": event.origin,
        "peerHandlers": [],
        "renderControllers": []
    };
    connections.push(connection);

    ws.onclose = function (event) {
        var i;
        for (i = 0; i < connection.renderControllers.length; i++) {
            connection.renderControllers[i].stop();
            jsonRpc.removeObjectRef(connection.renderControllers[i]);
            delete connection.renderControllers[i];
        }
        connection.renderControllers = null;
        for (i = 0; i < connection.peerHandlers.length; i++) {
            connection.peerHandlers[i].stop();
            jsonRpc.removeObjectRef(connection.peerHandlers[i]);
            delete connection.peerHandlers[i];
        }
        connection.peerHandlers = null;
        connections.splice(connections.indexOf(connection), 1);
        connection = null;
        rpcScope = null;
        jsonRpc = null;
        channel = null;
        ws = null;
    };

    rpcScope.createPeerHandler = function (configuration, client) {
        var peerHandler = new PeerHandler(configuration, client, jsonRpc);
        connection.peerHandlers.push(peerHandler);
        var exports = [ "prepareToReceive", "prepareToSend", "addRemoteCandidate" ];
        for (var i = 0; i < exports.length; i++)
            jsonRpc.exportFunctions(peerHandler[exports[i]]);
        return jsonRpc.createObjectRef(peerHandler, exports);
    };

    rpcScope.requestSources = function (options, client) {
        var mediaTypes = 0;
        if (options.audio)
            mediaTypes |= owr.MediaType.AUDIO;
        if (options.video)
            mediaTypes |= owr.MediaType.VIDEO;

        owr.get_capture_sources(mediaTypes, function (sources) {
            var sourceInfos = [];
            if (options.audio)
                pushSourceInfo("audio");
            if (options.video)
                pushSourceInfo("video");

            function pushSourceInfo(mediaType) {
                for (var i = 0; i < sources.length; i++) {
                    if (sources[i].media_type == owr.MediaType[mediaType.toUpperCase()]) {
                        if (mediaType == "video" && options.video.facingMode == "environment") {
                            delete options.video.facingMode;
                            continue;
                        }
                        sourceInfos.push({
                            "mediaType": mediaType,
                            "label": sources[i].name,
                            "source": jsonRpc.createObjectRef(sources[i])
                        });
                        break;
                    }
                }
            }
            client.gotSources(sourceInfos);
        });
    };

    rpcScope.renderSources = function (audioSources, videoSources, tag) {
        var audioRenderer;
        if (audioSources.length > 0) {
            audioRenderer = new owr.AudioRenderer({ "disabled": true });
            audioRenderer.set_source(audioSources[0]);
        }
        var imageServer;
        var imageServerPort = 0;
        var videoRenderer;
        if (videoSources.length > 0) {
            videoRenderer = new owr.ImageRenderer();
            videoRenderer.set_source(videoSources[0]);

            if (nextImageServerPort > imageServerBasePort + 10)
                nextImageServerPort = imageServerBasePort;
            imageServerPort = nextImageServerPort++;
            imageServer = imageServers[imageServerPort];
            if (!imageServer) {
                imageServer = imageServers[imageServerPort] = new owr.ImageServer({
                    "port": imageServerPort,
                    "allow-origin": origin
                });
            } else if (imageServer.allow_origin.split(" ").indexOf(origin) == -1)
                imageServer.allow_origin += " " + origin;
            imageServer.add_image_renderer(videoRenderer, tag);
        }

        var controller = new RenderController(audioRenderer, videoRenderer, imageServerPort, tag);
        connection.renderControllers.push(controller);
        jsonRpc.exportFunctions(controller.setAudioMuted, controller.stop);
        var controllerRef = jsonRpc.createObjectRef(controller, "setAudioMuted", "stop");

        return { "controller": controllerRef, "port": imageServerPort };
    };

    jsonRpc.exportFunctions(rpcScope.createPeerHandler, rpcScope.requestSources, rpcScope.renderSources);

};

function RenderController(audioRenderer, videoRenderer, imageServerPort, tag) {
    this.setAudioMuted = function (isMuted) {
        if (audioRenderer)
            audioRenderer.disabled = isMuted;
    };

    this.stop = function () {
        if (audioRenderer)
            audioRenderer.set_source(null);
        if (videoRenderer)
            videoRenderer.set_source(null);
        if (imageServerPort) {
            var imageServer = imageServers[imageServerPort];
            if (imageServer)
                imageServer.remove_image_renderer(tag);
        }

        audioRenderer = videoRenderer = imageServerPort = null;
    };

    this.hasAudio = function () { return !!audioRenderer; };
    this.hasVideo = function () { return !!videoRenderer; };

    this.getRendererDotData = function (mediaType) {
        switch (mediaType) {
        case "audio":
            return audioRenderer ? audioRenderer.get_dot_data() : "";
        case "video":
            return videoRenderer ? videoRenderer.get_dot_data() : "";
        default:
            return ""
        }
    };
}

var owr_js = "(function () {\n" + wbjsonrpc_js + domutils_js + sdp_js + webrtc_js + "\n})();";

server.onrequest = function (event) {
    var response = {"headers": {}};
    if (event.request.url == "/owr.js") {
        response.status = 200;
        response.headers["Content-Type"] = "text/javascript";
        response.headers["Access-Control-Allow-Origin"] = "*";
        response.body = owr_js;
    } else if (event.request.url == "/graph") {
        response.status = 200;
        response.headers["Content-Type"] = "text/html";
        response.body = "<!doctype html><html><head><title>Pipeline graphs</title></head><body>";
        for (var i = 0; i < connections.length; i++) {
            var j, k;
            var peerHandlers = connections[i].peerHandlers;
            var renderControllers = connections[i].renderControllers;
            response.body += "<h1>" + connections[i].origin + " #" + i + "</h1>";
            response.body += "<h2>Transport</h2>";
            for (j = 0; j < peerHandlers.length; j++) {
                response.body += "<a href=\"/graph/" + i + "/transport/agent/" + j + "\">" +
                    "Transport agent #" + j + "</a><br>";
                ["Send", "Receive"].forEach(function (sourceType) {
                    response.body += "<h3>" + sourceType + " sources</h3>";
                    for (k = 0; k < peerHandlers[j]["numberOf" + sourceType + "Sources"](); k++) {
                        response.body += "<a href=\"/graph/" + i + "/transport/agent/" + j +
                            "/" + sourceType.toLowerCase() + "/source/" + k + "\">" +
                            sourceType + " source #" + k + "</a><br>";
                    }
                });
            }
            response.body += "<h2>Rendering</h2>";
            for (j = 0; j < renderControllers.length; j++) {
                ["Audio", "Video"].forEach(function (mediaType) {
                    if (renderControllers[j]["has" + mediaType]()) {
                        response.body += "<a href=\"/graph/" + i + "/renderer/" + j +
                            "/" + mediaType.toLowerCase() + "\">" + mediaType +
                            " renderer #" + j + "</a><br>";
                    }
                });
            }
        }
        response.body += "</body></html>";
    } else if (event.request.url.substr(0, 7) == "/graph/") {
        var dotData;
        var parts = event.request.url.split("/");
        var connection = connections[parseInt(parts[2])];
        if (connection && parts[3] == "transport" && parts[4] == "agent") {
            var peerHandler = connection.peerHandlers[parseInt(parts[5])];
            if (peerHandler) {
                if (parts.length < 7)
                    dotData = peerHandler.getTransportAgentDotData();
                else if (parts.length > 8 && parts[7] == "source") {
                    var sourceIndex = parseInt(parts[8]);
                    if (parts[6] == "send")
                        dotData = peerHandler.getSendSourceDotData(sourceIndex);
                    else if (parts[6] == "receive")
                        dotData = peerHandler.getReceiveSourceDotData(sourceIndex);
                }
            }
        } else if (connection && parts[3] == "renderer") {
            var renderController = connection.renderControllers[parseInt(parts[4])];
            if (renderController)
                dotData = renderController.getRendererDotData(parts[5]);
        }
        response.status = 200;
        response.headers["Content-Type"] = "text/html";
        response.headers["Content-Security-Policy"] = "default-src 'none';" +
            "script-src 'unsafe-inline' http://mdaines.github.io/viz.js/viz.js;" +
            "sandbox allow-scripts;";
        response.body = "<!doctype html><html><head><title>Pipeline graph</title>" +
            "<meta name=\"referrer\" content=\"no-referrer\">" +
            "<script src=\"http://mdaines.github.io/viz.js/viz.js\"></script>" +
            "<script>window.onload = function () { document.body.innerHTML = " +
            (dotData ? "Viz(decodeURIComponent(\"" + encodeURIComponent(dotData) +
            "\"), \"svg\", \"dot\");" : "\"No dot data\";") +
            " };</script></head><body><h3>Please wait..</h3></body></html>";
    } else {
        response.status = 404;
        response.headers["Content-Type"] = "text/html";
        response.body = "<!doctype html><html><body><h1>404 Not Found</h1></body></html>";
    }
    event.request.respond(response);
};
